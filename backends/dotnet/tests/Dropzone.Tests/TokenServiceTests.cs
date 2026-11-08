using Dropzone.Api;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Xunit;

public class TokenServiceTests
{
    [Fact]
    public async Task IssuesHs256TokensWithTheSharedClaims()
    {
        var options = new AppOptions();
        var user = new UserDto(Guid.NewGuid(), "a@b.io", "admin");
        var token = new TokenService(options).Issue(user);

        var result = await new JsonWebTokenHandler().ValidateTokenAsync(token, new TokenValidationParameters
        {
            ValidIssuer = "dropzone",
            ValidateAudience = false,
            IssuerSigningKey = TokenService.SigningKey(options),
        });

        Assert.True(result.IsValid);
        var jwt = (JsonWebToken)result.SecurityToken;
        Assert.Equal("HS256", jwt.Alg);
        Assert.Equal(user.Id.ToString(), jwt.Subject);
        Assert.Equal("admin", jwt.GetClaim("role").Value);
        Assert.Equal("a@b.io", jwt.GetClaim("email").Value);
    }
}
