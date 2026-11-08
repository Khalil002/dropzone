FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/Dropzone.Api/Dropzone.Api.csproj src/Dropzone.Api/
RUN dotnet restore src/Dropzone.Api/Dropzone.Api.csproj
COPY src/ src/
RUN dotnet publish src/Dropzone.Api -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
USER app
EXPOSE 8000
ENTRYPOINT ["dotnet", "Dropzone.Api.dll"]
