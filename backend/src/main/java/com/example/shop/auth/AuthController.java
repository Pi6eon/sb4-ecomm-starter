package com.example.shop.auth;

import com.example.shop.platform.JwtService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {
    private final JwtService jwtService;

    public AuthController(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @PostMapping("/anonymous")
    TokenResponse anonymous() {
        return jwtService.issue("anon:" + UUID.randomUUID(), "anonymous");
    }

}
