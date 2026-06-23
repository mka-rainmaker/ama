package com.web;

import io.javalin.Javalin;

public class App {

    public void routes() {
        Javalin app = Javalin.create();
        app.get("/health", App::health);
        app.post("/items", App::createItem);
        app.put("/items/{id}", App::updateItem);
    }

    public static void health(Object ctx) {
    }

    public static void createItem(Object ctx) {
    }

    public static void updateItem(Object ctx) {
    }
}
