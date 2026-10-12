package com.example.shop.platform;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import jakarta.servlet.DispatcherType;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

@Configuration
public class ApiSecurityConfiguration {
    @Bean
    SecurityFilterChain apiSecurity(HttpSecurity http, JwtAuthenticationFilter jwtFilter,
                                    RedisRateLimitFilter rateLimitFilter,
                                    WaitingRoomGateFilter waitingRoomGateFilter,
                                    CorsConfigurationSource corsConfigurationSource) throws Exception {
        return http
                .csrf(AbstractHttpConfigurer::disable)
                .cors(cors -> cors.configurationSource(corsConfigurationSource))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
                        .requestMatchers("/actuator/health", "/actuator/health/**",
                                "/actuator/prometheus", "/api/v1/auth/**", "/api/v1/oauth/token",
                                "/api/v1/guest-access/**", "/api/v1/waiting-room/**", "/api/v1/discovery/**")
                        .permitAll()
                        .requestMatchers("/api/v1/profile/**")
                        .hasAnyAuthority("TOKEN_CUSTOMER", "TOKEN_GUEST_VERIFIED")
                        .requestMatchers(HttpMethod.GET, "/api/v1/short-links/**").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/v1/short-links")
                        .hasAnyAuthority("TOKEN_CUSTOMER", "SCOPE_short-links:write")
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/v1/products", "/api/v1/products/**")
                        .hasAnyAuthority("TOKEN_ANONYMOUS", "TOKEN_GUEST", "TOKEN_CUSTOMER", "SCOPE_catalog:read")
                        .requestMatchers(HttpMethod.POST, "/api/v1/orders")
                        .hasAnyAuthority("TOKEN_GUEST", "TOKEN_CUSTOMER", "SCOPE_orders:write")
                        .requestMatchers(HttpMethod.GET, "/api/v1/orders", "/api/v1/orders/**")
                        .hasAnyAuthority("TOKEN_GUEST_VERIFIED", "TOKEN_CUSTOMER", "SCOPE_orders:read")
                        .anyRequest().authenticated())
                .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(rateLimitFilter, JwtAuthenticationFilter.class)
                .addFilterAfter(waitingRoomGateFilter, RedisRateLimitFilter.class)
                .build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(12);
    }

    @Bean
    FilterRegistrationBean<JwtAuthenticationFilter> jwtFilterServletRegistration(JwtAuthenticationFilter filter) {
        var registration = new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    @Bean
    FilterRegistrationBean<RedisRateLimitFilter> rateLimitFilterServletRegistration(RedisRateLimitFilter filter) {
        var registration = new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    @Bean
    FilterRegistrationBean<WaitingRoomGateFilter> waitingRoomFilterServletRegistration(WaitingRoomGateFilter filter) {
        var registration = new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource(
            @org.springframework.beans.factory.annotation.Value("${app.security.allowed-origins}") List<String> origins) {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOrigins(origins);
        configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(List.of("Authorization", "Content-Type", "Idempotency-Key",
                "X-Request-Id", "X-Session-Id", "X-Waiting-Room-Ticket"));
        configuration.setExposedHeaders(List.of("X-Request-Id", "Retry-After"));
        configuration.setAllowCredentials(false);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", configuration);
        return source;
    }
}
