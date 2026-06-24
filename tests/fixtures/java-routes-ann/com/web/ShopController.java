package com.web;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;

@RequestMapping("/shop")
public class ShopController {

    // Named-arg out-of-order: produces is first, value is second — must use value, not produces value.
    @GetMapping(produces = "application/json", value = "/search")
    public String search() { return null; }

    // Named path= (not value=) out-of-order: produces is first, path is second.
    @PostMapping(produces = "application/json", path = "/orders")
    public String placeOrder() { return null; }

    // Fully-qualified annotation — must resolve GetMapping despite the FQN prefix.
    @org.springframework.web.bind.annotation.GetMapping("/fqn")
    public String fqnRoute() { return null; }

    // Positional (baseline) — must still work unchanged.
    @GetMapping("/simple")
    public String simple() { return null; }
}

class AdminController {

    // Spring property placeholders are not path variables; only {sessionId} should normalize.
    @GetMapping("${agentscope.admin.base-path:/v1/admin}/sessions/{sessionId}:export")
    public String export() { return null; }
}
