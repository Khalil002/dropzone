using System.Security.Claims;
using System.Text;
using Dapper;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

namespace Dropzone.Api;

public sealed record UserDto(Guid Id, string Email, string Role);

/// <summary>Issues the HS256 token every backend accepts (claims: sub, email, role, iss=dropzone).</summary>
public sealed class TokenService(AppOptions options)
{
    public const string Issuer = "dropzone";

    public static SymmetricSecurityKey SigningKey(AppOptions options) => new(Encoding.UTF8.GetBytes(options.JwtSecret));

    public string Issue(UserDto user)
    {
        var now = DateTime.UtcNow;
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            IssuedAt = now,
            NotBefore = now,
            Expires = now.AddSeconds(options.JwtTtlSec),
            Claims = new Dictionary<string, object>
            {
                ["sub"] = user.Id.ToString(),
                ["email"] = user.Email,
                ["role"] = user.Role,
            },
            SigningCredentials = new SigningCredentials(SigningKey(options), SecurityAlgorithms.HmacSha256),
        };
        return new JsonWebTokenHandler().CreateToken(descriptor);
    }
}

public static class CurrentUser
{
    public static Guid Id(ClaimsPrincipal user) => Guid.Parse(user.FindFirstValue("sub")!);
}

public static class AuthEndpoints
{
    public sealed record Credentials(string? Email, string? Password);

    private sealed class UserRow
    {
        public Guid Id { get; set; }
        public string Email { get; set; } = "";
        public string Role { get; set; } = "";
        public string PasswordHash { get; set; } = "";
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapPost("/auth/register", Register);
        api.MapPost("/auth/login", Login);
        api.MapGet("/me", Me).RequireAuthorization();
        api.MapGet("/me/notifications", Notifications).RequireAuthorization();
    }

    private static async Task<IResult> Register(Credentials body, NpgsqlDataSource db, AppOptions options, TokenService tokens)
    {
        var email = body.Email?.Trim().ToLowerInvariant() ?? "";
        var problems = new List<string>();
        if (!Rules.IsEmail(email)) problems.Add("email: must be an email address");
        if (body.Password is not { Length: >= 8 and <= 72 }) problems.Add("password: must be 8-72 characters");
        if (problems.Count > 0) throw ApiException.Validation(string.Join("; ", problems));

        var hash = BCrypt.Net.BCrypt.HashPassword(body.Password, 10);
        await using var conn = await db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        UserDto user;
        try
        {
            user = await conn.QuerySingleAsync<UserDto>(
                "INSERT INTO users (email, password_hash) VALUES (@email, @hash) RETURNING id, email, role",
                new { email, hash }, tx);
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new ApiException(409, "EMAIL_TAKEN", "Email is already registered");
        }

        var accountId = await conn.QuerySingleAsync<Guid>(
            "INSERT INTO accounts (user_id, kind) VALUES (@id, 'customer') RETURNING id", new { id = user.Id }, tx);
        // Signup credit is a balanced ledger transaction: promo pays, customer receives.
        var credit = options.SignupCreditCents;
        var txId = await conn.QuerySingleAsync<Guid>(
            "INSERT INTO ledger_transactions (kind, reference_id) VALUES ('signup_bonus', @id) RETURNING id", new { id = user.Id }, tx);
        await conn.ExecuteAsync(
            "INSERT INTO ledger_entries (transaction_id, account_id, amount_cents) VALUES (@txId, @promo, @debit), (@txId, @accountId, @credit)",
            new { txId, promo = AppOptions.PromoAccountId, debit = -credit, accountId, credit }, tx);
        await conn.ExecuteAsync("UPDATE accounts SET balance_cents = balance_cents - @credit WHERE id = @id",
            new { credit, id = AppOptions.PromoAccountId }, tx);
        await conn.ExecuteAsync("UPDATE accounts SET balance_cents = balance_cents + @credit WHERE id = @id",
            new { credit, id = accountId }, tx);
        await tx.CommitAsync();
        return Results.Json(new { token = tokens.Issue(user), user }, statusCode: 201);
    }

    private static async Task<IResult> Login(Credentials body, NpgsqlDataSource db, TokenService tokens)
    {
        var email = body.Email?.Trim().ToLowerInvariant() ?? "";
        await using var conn = await db.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<UserRow>(
            "SELECT id, email, role, password_hash FROM users WHERE lower(email) = @email", new { email });
        if (row is null || !BCrypt.Net.BCrypt.Verify(body.Password ?? "", row.PasswordHash))
            throw new ApiException(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
        var user = new UserDto(row.Id, row.Email, row.Role);
        return Results.Ok(new { token = tokens.Issue(user), user });
    }

    private sealed class MeRow
    {
        public Guid Id { get; set; }
        public string Email { get; set; } = "";
        public string Role { get; set; } = "";
        public long BalanceCents { get; set; }
    }

    private static async Task<IResult> Me(ClaimsPrincipal principal, NpgsqlDataSource db)
    {
        await using var conn = await db.OpenConnectionAsync();
        var me = await conn.QuerySingleOrDefaultAsync<MeRow>(
            """
            SELECT u.id, u.email, u.role, COALESCE(a.balance_cents, 0) AS balance_cents
              FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.id = @id
            """, new { id = CurrentUser.Id(principal) });
        return me is null ? throw ApiException.NotFound("User") : Results.Ok(me);
    }

    private sealed class NotificationRow
    {
        public Guid Id { get; set; }
        public string Kind { get; set; } = "";
        public string Message { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    private static async Task<IResult> Notifications(ClaimsPrincipal principal, NpgsqlDataSource db)
    {
        await using var conn = await db.OpenConnectionAsync();
        var rows = await conn.QueryAsync<NotificationRow>(
            "SELECT id, kind, message, created_at FROM notifications WHERE user_id = @id ORDER BY created_at DESC LIMIT 50",
            new { id = CurrentUser.Id(principal) });
        return Results.Ok(rows);
    }
}
