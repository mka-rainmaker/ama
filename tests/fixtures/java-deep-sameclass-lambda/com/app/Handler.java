package com.app;

import java.io.PrintStream;
import java.util.Locale;

class Handler {
    Result executeTask(
        RunnableContext runnableContext,
        Task task,
        Locale locale,
        Log log,
        PrintStream logStream,
        Listener listener
    ) {
        Settings settings = new Settings();
        executeWithSettings(runnableContext, task, locale, log, logStream, listener, settings);
        return Result.ok();
    }

    private void executeWithSettings(
        RunnableContext runnableContext,
        Task task,
        Locale locale,
        Log log,
        PrintStream logStream,
        Listener listener,
        Settings settings
    ) {
        runnableContext.run(() -> {
            runScripts(task, settings, log, logStream);
        });
    }

    private void runScripts(Task task, Settings settings, Log log, PrintStream logStream) {
        processScript(task, settings, log, logStream);
    }

    private void processScript(Task task, Settings settings, Log log, PrintStream logStream) {
    }
}
