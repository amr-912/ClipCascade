package com.acme.clipcascade.controller;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;

import static org.junit.jupiter.api.Assertions.*;

/** No cloud network or credential needed: disabled issuer must fail closed. */
class IceServersControllerTest {
    @Test
    void missingCredentialsRejectsIssuance() {
        var controller = new IceServersController("", "");
        var response = controller.getIceServers(new MockHttpSession());
        assertEquals(503, response.getStatusCode().value());
        assertTrue(response.getHeaders().getCacheControl().contains("no-store"));
        assertFalse(String.valueOf(response.getBody()).contains("credential"));
    }

    @Test
    void invalidKeyIdRejectsIssuanceWithoutCallingProvider() {
        var controller = new IceServersController("not/a/key", "test-token");
        var response = controller.getIceServers(new MockHttpSession());
        assertEquals(503, response.getStatusCode().value());
    }
}
