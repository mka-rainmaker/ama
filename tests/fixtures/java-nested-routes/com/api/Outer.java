package com.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** A nested `@RestController`: the handler Method node is `Outer.Inner.list` (full dotted chain), so
 *  the Route → References → handler edge must target `Outer.Inner.list`, not the simple `Inner.list`. */
public class Outer {

    @RestController
    @RequestMapping("/api")
    static class Inner {
        @GetMapping("/books")
        String list() {
            return "[]";
        }
    }
}
