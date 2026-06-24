package com.app;

import com.lib.Operations;
import com.lib.Service;

public class Controller implements Service {
    private final Operations ops;

    public Controller(Operations ops) {
        this.ops = ops;
    }

    @Override
    public String export(String sessionId) {
        return finish(this.ops.exportMarkdown(sessionId));
    }

    private String finish(String value) {
        return value;
    }
}
