using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Dapper;
using Npgsql;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;

namespace Dropzone.Api;

/// <summary>Runs a tick on a fixed delay; failures are logged and the loop carries on.</summary>
public abstract class LoopService(ILogger logger, int intervalMs) : BackgroundService
{
    protected abstract Task Tick(CancellationToken ct);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Tick(ct); }
            catch (Exception e) when (!ct.IsCancellationRequested) { logger.LogWarning("{Service} tick failed: {Message}", GetType().Name, e.Message); }
            try { await Task.Delay(intervalMs, ct); } catch (TaskCanceledException) { }
        }
    }
}

/// <summary>
/// Admits the head of each live queue. The admission key is written before the member leaves
/// the queue, so a poll never sees someone as neither waiting nor admitted. Running this on
/// several instances at once is harmless: admitting twice is a no-op.
/// </summary>
public sealed class Admitter(DropRepository drops, IConnectionMultiplexer redis, AppOptions options, ILogger<Admitter> logger)
    : LoopService(logger, options.AdmitIntervalMs)
{
    protected override async Task Tick(CancellationToken ct)
    {
        var db = redis.GetDatabase();
        foreach (var dropId in await drops.LiveWithStock())
        {
            var head = await db.SortedSetRangeByRankAsync(RedisKeys.Queue(dropId), 0, options.AdmitBatch - 1);
            if (head.Length == 0) continue;
            foreach (var userId in head)
                await db.StringSetAsync(RedisKeys.Admitted(dropId, Guid.Parse(userId!)), "1", TimeSpan.FromSeconds(options.AdmissionTtlSec));
            await db.SortedSetRemoveAsync(RedisKeys.Queue(dropId), head);
        }
    }
}

/// <summary>Lazily (re)connects to RabbitMQ and declares the topology every backend shares.</summary>
public sealed class Rabbit(AppOptions options) : IDisposable
{
    public const string Exchange = "dropzone.events";
    public const string NotificationQueue = "dropzone.notifications";
    private readonly object _lock = new();
    private IConnection? _connection;

    public IModel OpenChannel()
    {
        lock (_lock)
        {
            if (_connection is not { IsOpen: true })
            {
                _connection?.Dispose();
                _connection = new ConnectionFactory
                {
                    HostName = options.RabbitHost, Port = options.RabbitPort,
                    UserName = options.RabbitUser, Password = options.RabbitPassword,
                    DispatchConsumersAsync = true,
                }.CreateConnection();
            }
            var channel = _connection.CreateModel();
            channel.ExchangeDeclare(Exchange, ExchangeType.Topic, durable: true);
            channel.QueueDeclare(NotificationQueue, durable: true, exclusive: false, autoDelete: false);
            channel.QueueBind(NotificationQueue, Exchange, "order.confirmed");
            return channel;
        }
    }

    public void Dispose() => _connection?.Dispose();
}

/// <summary>
/// Relays committed outbox rows to RabbitMQ. SKIP LOCKED lets several instances share the
/// table, and rows are marked published only after the broker confirms them.
/// </summary>
public sealed class OutboxPublisher(NpgsqlDataSource db, Rabbit rabbit, ILogger<OutboxPublisher> logger) : LoopService(logger, 500)
{
    private IModel? _channel;

    private sealed class Row
    {
        public long Id { get; set; }
        public Guid EventId { get; set; }
        public string EventType { get; set; } = "";
        public string Payload { get; set; } = "";
    }

    protected override async Task Tick(CancellationToken ct)
    {
        if (_channel is not { IsOpen: true })
        {
            _channel = rabbit.OpenChannel();
            _channel.ConfirmSelect();
        }
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var rows = (await conn.QueryAsync<Row>(
            "SELECT id, event_id, event_type, payload::text AS payload FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED",
            transaction: tx)).ToList();
        if (rows.Count == 0) return;
        foreach (var row in rows)
        {
            var body = new JsonObject { ["eventId"] = row.EventId.ToString() };
            foreach (var (k, v) in JsonNode.Parse(row.Payload)!.AsObject()) body[k] = v?.DeepClone();
            var props = _channel.CreateBasicProperties();
            props.Persistent = true;
            props.ContentType = "application/json";
            props.MessageId = row.EventId.ToString();
            props.Type = row.EventType;
            _channel.BasicPublish(Rabbit.Exchange, row.EventType, props, Encoding.UTF8.GetBytes(body.ToJsonString()));
        }
        _channel.WaitForConfirmsOrDie(TimeSpan.FromSeconds(5));
        await conn.ExecuteAsync("UPDATE outbox_events SET published_at = now() WHERE id = ANY(@ids)",
            new { ids = rows.Select(r => r.Id).ToArray() }, tx);
        await tx.CommitAsync(ct);
    }
}

/// <summary>Turns order.confirmed events into notifications; event_id makes redelivery harmless.</summary>
public sealed class NotificationConsumer(NpgsqlDataSource db, Rabbit rabbit, ILogger<NotificationConsumer> logger)
    : LoopService(logger, 2000)
{
    private IModel? _channel;

    protected override Task Tick(CancellationToken ct)
    {
        if (_channel is { IsOpen: true }) return Task.CompletedTask; // already consuming
        _channel = rabbit.OpenChannel();
        _channel.BasicQos(0, 20, false);
        var consumer = new AsyncEventingBasicConsumer(_channel);
        var channel = _channel;
        consumer.Received += async (_, ea) =>
        {
            try
            {
                using var doc = JsonDocument.Parse(ea.Body.ToArray());
                var e = doc.RootElement;
                await using var conn = await db.OpenConnectionAsync();
                await conn.ExecuteAsync(
                    "INSERT INTO notifications (user_id, event_id, kind, message) VALUES (@userId, @eventId, 'order.confirmed', @message) ON CONFLICT (event_id) DO NOTHING",
                    new
                    {
                        userId = Guid.Parse(e.GetProperty("userId").GetString()!),
                        eventId = Guid.Parse(e.GetProperty("eventId").GetString()!),
                        message = Rules.NotificationMessage(e.GetProperty("quantity").GetInt32(), e.GetProperty("dropName").GetString()!),
                    });
                channel.BasicAck(ea.DeliveryTag, false);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "notification consumer failed");
                channel.BasicNack(ea.DeliveryTag, false, requeue: !ea.Redelivered); // retry once, then drop
            }
        };
        _channel.BasicConsume(Rabbit.NotificationQueue, autoAck: false, consumer);
        logger.LogInformation("consuming {Queue}", Rabbit.NotificationQueue);
        return Task.CompletedTask;
    }
}
