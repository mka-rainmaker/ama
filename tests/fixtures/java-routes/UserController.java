package com.example;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/users")
public class UserController {

    @GetMapping
    public List<User> list() {
        return null;
    }

    @GetMapping("/{id}")
    public User get(@PathVariable Long id) {
        return null;
    }

    @PostMapping
    public User create(@RequestBody User u) {
        return null;
    }
}
