package dev.dropzone.drops;

import dev.dropzone.domain.Rules;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class DropRepository {
    private static final String COLUMNS = "id, name, description, price_cents, total_stock, remaining_stock, starts_at";
    private final JdbcClient db;

    public DropRepository(JdbcClient db) {
        this.db = db;
    }

    static Drop map(ResultSet rs, int i) throws SQLException {
        return Drop.of(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("description"),
                rs.getLong("price_cents"), rs.getInt("total_stock"), rs.getInt("remaining_stock"),
                rs.getTimestamp("starts_at").toInstant());
    }

    public List<Drop> list() {
        return db.sql("SELECT " + COLUMNS + " FROM drops ORDER BY starts_at DESC LIMIT 100").query(DropRepository::map).list();
    }

    public Optional<Drop> find(String id) {
        if (!Rules.isUuid(id)) return Optional.empty();
        return db.sql("SELECT " + COLUMNS + " FROM drops WHERE id = ?").param(UUID.fromString(id))
                .query(DropRepository::map).optional();
    }

    public Drop create(String name, String description, long priceCents, int totalStock, OffsetDateTime startsAt) {
        return db.sql("INSERT INTO drops (name, description, price_cents, total_stock, remaining_stock, starts_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?) RETURNING " + COLUMNS)
                .params(name, description, priceCents, totalStock, totalStock, startsAt)
                .query(DropRepository::map).single();
    }

    public List<UUID> liveWithStock() {
        return db.sql("SELECT id FROM drops WHERE starts_at <= now() AND remaining_stock > 0").query(UUID.class).list();
    }
}
