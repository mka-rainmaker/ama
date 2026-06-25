package com.app;

class Worker extends BaseWorker implements TaskService {
    public String handle(String input) {
        return inherited(input);
    }

    String onlyWorker() {
        return "worker";
    }
}
