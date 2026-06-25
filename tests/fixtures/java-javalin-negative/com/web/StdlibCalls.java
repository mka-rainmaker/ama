package com.web;

import java.util.Map;
import java.util.Optional;

/** No Javalin here — only stdlib calls whose method names collide with Javalin verbs. The route
 *  detector must emit ZERO Route nodes: `map.get("k")` / `cache.put("k", v)` are NOT routes. */
public class StdlibCalls {

    public String lookup(Map<String, String> map, Map<String, String> cache, Optional<String> opt) {
        cache.put("/k", "v");
        String targetName = map.get("targetName");
        cache.put("/targetName", targetName);
        opt.get();
        return map.get("userId");
    }
}
