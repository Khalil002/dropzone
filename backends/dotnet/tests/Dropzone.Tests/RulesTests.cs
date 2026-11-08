using Dropzone.Api;
using Xunit;

public class RulesTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void SoldOutWinsOverStartTime() =>
        Assert.Equal("sold_out", Rules.DropStatus(0, Now.AddYears(1), Now));

    [Fact]
    public void UpcomingBeforeStartLiveFromStart()
    {
        Assert.Equal("upcoming", Rules.DropStatus(5, Now.AddSeconds(1), Now));
        Assert.Equal("live", Rules.DropStatus(5, Now, Now));
    }

    [Fact]
    public void CheckoutHashMatchesTheOtherBackends()
    {
        var id = Guid.Parse("00000000-0000-0000-0000-000000000ABC");
        Assert.Equal("29a1d8a96621022b392fc68a5458ca86d949f47552fcc41265514498316a5ffa", Rules.CheckoutRequestHash(id, 2));
        Assert.NotEqual(Rules.CheckoutRequestHash(id, 1), Rules.CheckoutRequestHash(id, 2));
    }

    [Fact]
    public void RateWindowsAreFixedBuckets()
    {
        Assert.Equal(new Rules.RateWindow(10, 10), Rules.RateWindowAt(100_000, 10));
        Assert.Equal(new Rules.RateWindow(10, 1), Rules.RateWindowAt(109_500, 10));
        Assert.Equal(11, Rules.RateWindowAt(110_000, 10).Window);
    }

    [Theory]
    [InlineData("a@b.io", true)]
    [InlineData("nope", false)]
    [InlineData("a b@c.io", false)]
    public void ValidatesEmails(string email, bool valid) => Assert.Equal(valid, Rules.IsEmail(email));

    [Theory]
    [InlineData("2026-01-01T00:00:00Z", true)]
    [InlineData("2026-01-01T02:00:00.500+02:00", true)]
    [InlineData("2026-01-01", false)]
    [InlineData("yesterday", false)]
    public void ParsesIsoTimestampsOnly(string value, bool valid)
    {
        Assert.Equal(valid, Rules.TryParseTimestamp(value, out var utc));
        if (valid) Assert.Equal(DateTimeKind.Utc, utc.Kind);
    }

    [Fact]
    public void SmallHelpers()
    {
        Assert.Equal(15000, Rules.OrderTotal(7500, 2));
        Assert.Equal("Order confirmed: 1 x Runner", Rules.NotificationMessage(1, "Runner"));
        Assert.False(Rules.IsValidIdempotencyKey("short"));
        Assert.True(Rules.IsValidIdempotencyKey("long-enough"));
        Assert.False(Rules.IsValidIdempotencyKey(new string('x', 129)));
    }
}
