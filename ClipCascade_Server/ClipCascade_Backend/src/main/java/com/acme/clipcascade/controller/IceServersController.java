package com.acme.clipcascade.controller;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.time.Instant;
import java.util.Map;

/**
 * Authenticated TURN credential issuer. All routes other than explicit public
 * paths require a logged-in Spring session (SecurityConfiguration).
 * A Cloudflare TURN long-term secret NEVER reaches an Android/Windows client.
 * Not operational until the server operator provisions the two env variables.
 */
@RestController
public class IceServersController {
    private static final int TTL_SECONDS = 3600;
    private static final int MAX_CACHE_AGE_SECONDS = 2700;
    private static final String SESSION_CACHE = "clipcascade.ephemeral.ice";
    private final String keyId;
    private final String apiToken;
    private final RestClient rest;

    public IceServersController(
            @Value("${CLIPCASCADE_TURN_KEY_ID:}") String keyId,
            @Value("${CLIPCASCADE_TURN_API_TOKEN:}") String apiToken) {
        this.keyId = keyId.trim();
        this.apiToken = apiToken.trim();
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(3000);
        factory.setReadTimeout(5000);
        this.rest = RestClient.builder().requestFactory(factory).build();
    }

    @GetMapping(path = "/ice-servers", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getIceServers(HttpSession session) {
        if (!keyId.matches("[a-zA-Z0-9_-]{1,128}") || apiToken.isBlank()) {
            return ResponseEntity.status(503).cacheControl(CacheControl.noStore())
                    .body(Map.of("available", false, "reason", "TURN_NOT_CONFIGURED"));
        }
        synchronized (session) {
            long now = Instant.now().getEpochSecond();
            Object cached = session.getAttribute(SESSION_CACHE);
            if (cached instanceof CachedIce c && now < c.cachedAt() + MAX_CACHE_AGE_SECONDS) {
                return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(c.payload());
            }
            try {
                JsonNode response = rest.post()
                        .uri("https://rtc.live.cloudflare.com/v1/turn/keys/" +
                                keyId + "/credentials/generate-ice-servers")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + apiToken)
                        .body(Map.of("ttl", TTL_SECONDS))
                        .retrieve().body(JsonNode.class);
                if (response == null || !response.has("iceServers")
                        || !response.get("iceServers").isArray()
                        || response.get("iceServers").isEmpty()) {
                    throw new IllegalStateException("Invalid TURN provider response");
                }
                Map<String, Object> payload = Map.of(
                        "iceServers", response.get("iceServers"),
                        "expiresAt", (now + TTL_SECONDS) * 1000L,
                        "provider", "managed-turn");
                session.setAttribute(SESSION_CACHE, new CachedIce(now, payload));
                return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(payload);
            } catch (RestClientException | IllegalStateException e) {
                // No credentials, session cookies, or provider error bodies in logs.
                return ResponseEntity.status(503).cacheControl(CacheControl.noStore())
                        .body(Map.of("available", false, "reason", "TURN_TEMPORARILY_UNAVAILABLE"));
            }
        }
    }

    private record CachedIce(long cachedAt, Map<String, Object> payload)
            implements java.io.Serializable {}
}
