package com.example.shop.auth;

public record TokenResponse(String accessToken, String tokenType, long expiresIn, String scope) {}
