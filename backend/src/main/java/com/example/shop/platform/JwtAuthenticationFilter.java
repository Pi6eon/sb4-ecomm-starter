package com.example.shop.platform;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;
import java.util.Set;

@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {
    private static final Set<String> TOKEN_TYPES =
            Set.of("anonymous", "guest", "guest_verified", "customer", "client");
    private final JwtService jwtService;

    public JwtAuthenticationFilter(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String authorization = request.getHeader("Authorization");
        if (authorization != null && authorization.startsWith("Bearer ")) {
            try {
                Claims claims = jwtService.parse(authorization.substring(7));
                String tokenType = claims.get("token_type", String.class);
                if (!TOKEN_TYPES.contains(tokenType) || claims.getSubject() == null) {
                    response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Invalid bearer token");
                    return;
                }
                var authorities = new java.util.ArrayList<SimpleGrantedAuthority>();
                authorities.add(new SimpleGrantedAuthority("TOKEN_" + tokenType.toUpperCase()));
                if (tokenType.equals("client")) {
                    List<?> scopes = claims.get("scope", List.class);
                    if (scopes == null || scopes.isEmpty()
                            || scopes.stream().anyMatch(scope -> !(scope instanceof String))) {
                        response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Invalid client scopes");
                        return;
                    }
                    scopes.stream().map(String.class::cast)
                            .map(scope -> new SimpleGrantedAuthority("SCOPE_" + scope))
                            .forEach(authorities::add);
                }
                var authentication = UsernamePasswordAuthenticationToken.authenticated(
                        claims.getSubject(), null, authorities);
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (JwtException | IllegalArgumentException ex) {
                SecurityContextHolder.clearContext();
                response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Invalid bearer token");
                return;
            }
        }
        chain.doFilter(request, response);
    }
}
