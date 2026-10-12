package com.example.shop.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.UUID;

@RestController
@RequestMapping("/api/v1/profile")
public class CustomerProfileController {
    private final JdbcClient jdbc;

    public CustomerProfileController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping
    ProfileResponse get(Authentication authentication) {
        if (hasAuthority(authentication, "TOKEN_CUSTOMER")) {
            return jdbc.sql("""
                    SELECT email, display_name FROM customers
                    WHERE id = :id AND email_verified = TRUE
                    """).param("id", customerId(authentication))
                    .query((rs, row) -> new ProfileResponse(
                            rs.getString("email"), rs.getString("display_name"), "customer"))
                    .optional()
                    .orElseThrow(CustomerProfileController::unauthorizedProfile);
        }
        if (hasAuthority(authentication, "TOKEN_GUEST_VERIFIED")) {
            String email = authentication.getName();
            jdbc.sql("""
                    INSERT INTO guest_profiles (email) VALUES (:email)
                    ON CONFLICT (email) DO NOTHING
                    """).param("email", email).update();
            return jdbc.sql("SELECT email, display_name FROM guest_profiles WHERE email = :email")
                    .param("email", email)
                    .query((rs, row) -> new ProfileResponse(
                            rs.getString("email"), rs.getString("display_name"), "guest"))
                    .single();
        }
        throw unauthorizedProfile();
    }

    @PutMapping
    ProfileResponse update(
            @Valid @RequestBody ProfileUpdate update,
            Authentication authentication) {
        String displayName = update.displayName() == null ? "" : update.displayName().trim();
        if (hasAuthority(authentication, "TOKEN_CUSTOMER")) {
            int updated = jdbc.sql("""
                    UPDATE customers SET display_name = :name, updated_at = CURRENT_TIMESTAMP
                    WHERE id = :id AND email_verified = TRUE
                    """).param("name", displayName)
                    .param("id", customerId(authentication)).update();
            if (updated != 1) throw unauthorizedProfile();
            return get(authentication);
        }
        if (hasAuthority(authentication, "TOKEN_GUEST_VERIFIED")) {
            String email = authentication.getName();
            int updated = jdbc.sql("""
                    INSERT INTO guest_profiles (email, display_name)
                    VALUES (:email, :name)
                    ON CONFLICT (email) DO UPDATE
                    SET display_name = EXCLUDED.display_name, updated_at = CURRENT_TIMESTAMP
                    """).param("email", email).param("name", displayName).update();
            if (updated != 1) throw new IllegalStateException("Unable to update guest profile");
            return get(authentication);
        }
        throw unauthorizedProfile();
    }

    private static UUID customerId(Authentication authentication) {
        try {
            return UUID.fromString(authentication.getName());
        } catch (IllegalArgumentException ex) {
            throw unauthorizedProfile();
        }
    }

    private static boolean hasAuthority(Authentication authentication, String expected) {
        return authentication != null && authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(expected::equals);
    }

    private static ResponseStatusException unauthorizedProfile() {
        return new ResponseStatusException(HttpStatus.FORBIDDEN, "Verified guest or customer access required");
    }

    public record ProfileUpdate(@Size(max = 100) String displayName) {}
    public record ProfileResponse(String email, String displayName, String accountType) {}
}
