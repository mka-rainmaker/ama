package com.app;

class Runner {
    private final TaskService service;

    Runner(Worker worker) {
        this.service = worker;
    }

    String run(Worker worker, Factory factory) {
        var helper = new Helper();
        var fromFactory = factory.create();
        var alias = worker;

        helper.step();
        fromFactory.step();
        alias.onlyWorker();
        worker.inherited("x");
        this.service.handle("y");
        new Widget("z");
        missing.nope();

        return "ok";
    }
}
