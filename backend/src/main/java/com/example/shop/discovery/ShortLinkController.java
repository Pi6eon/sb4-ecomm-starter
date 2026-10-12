package com.example.shop.discovery;

import com.example.shop.catalog.CatalogService;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.UUID;
import java.time.Instant;
import java.time.Duration;
import java.sql.Timestamp;

@RestController
@RequestMapping("/api/v1/short-links")
public class ShortLinkController {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final JdbcClient jdbc;
    private final CatalogService catalog;
    private final String publicWebUrl;
    private final MeterRegistry metrics;

    public ShortLinkController(
            JdbcClient jdbc,
            CatalogService catalog,
            MeterRegistry metrics,
            @Value("${app.public-web-url}") String publicWebUrl) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.metrics = metrics;
        this.publicWebUrl = publicWebUrl.replaceAll("/+$", "");
    }

    @PostMapping
    CreatedShortLink create(@Valid @RequestBody CreateRequest request, Authentication authentication) {
        if (catalog.findActiveById(request.productId()).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Product not found");
        }
        Instant expiresAt = Instant.now().plusSeconds(
                request.expiresInSeconds() == null ? Duration.ofDays(30).toSeconds() : request.expiresInSeconds());
        for (int attempt = 0; attempt < 5; attempt++) {
            byte[] random = new byte[6];
            RANDOM.nextBytes(random);
            String code = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
            try {
                jdbc.sql("""
                        INSERT INTO short_links (code, product_id, created_by, expires_at)
                        VALUES (:code, :productId, :createdBy, :expiresAt)
                        """).param("code", code)
                        .param("productId", request.productId())
                        .param("createdBy", authentication.getName())
                        .param("expiresAt", Timestamp.from(expiresAt))
                        .update();
                metrics.counter("shop_short_links_created_total").increment();
                return new CreatedShortLink(code, publicWebUrl + "/s/" + code, expiresAt);
            } catch (org.springframework.dao.DuplicateKeyException collision) {
                if (attempt == 4) throw collision;
            }
        }
        throw new IllegalStateException("Short link could not be created");
    }

    @GetMapping("/{code}")
    ResponseEntity<Void> redirect(@PathVariable String code) {
        if (!code.matches("[A-Za-z0-9_-]{8}")) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Short link not found");
        }
        ShortLinkRecord link;
        try {
            link = jdbc.sql("""
                    SELECT product_id, expires_at, revoked_at
                    FROM short_links WHERE code = :code
                    """)
                    .param("code", code)
                    .query((rs, row) -> new ShortLinkRecord(
                            rs.getObject("product_id", UUID.class),
                            rs.getTimestamp("expires_at").toInstant(),
                            rs.getTimestamp("revoked_at") == null ? null : rs.getTimestamp("revoked_at").toInstant()))
                    .single();
        } catch (org.springframework.dao.EmptyResultDataAccessException missing) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Short link not found");
        }
        if (link.revokedAt() != null || !link.expiresAt().isAfter(Instant.now())) {
            throw new ResponseStatusException(HttpStatus.GONE, "Short link has expired or been revoked");
        }
        if (catalog.findActiveById(link.productId()).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.GONE, "Linked product is no longer available");
        }
        metrics.counter("shop_short_links_redirects_total").increment();
        return ResponseEntity.status(HttpStatus.FOUND)
                .header(HttpHeaders.LOCATION, publicWebUrl + "/products/" + link.productId())
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .build();
    }

    @DeleteMapping("/{code}")
    ResponseEntity<Void> revoke(@PathVariable String code, Authentication authentication) {
        int revoked = jdbc.sql("""
                UPDATE short_links
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE code = :code AND created_by = :createdBy AND revoked_at IS NULL
                """).param("code", code).param("createdBy", authentication.getName()).update();
        if (revoked != 1) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Short link not found");
        }
        metrics.counter("shop_short_links_revoked_total").increment();
        return ResponseEntity.noContent().build();
    }

    public record CreateRequest(
            @NotNull UUID productId,
            @Min(60) @Max(31_536_000) Long expiresInSeconds) {}
    public record CreatedShortLink(String code, String url, Instant expiresAt) {}
    private record ShortLinkRecord(UUID productId, Instant expiresAt, Instant revokedAt) {}
}
