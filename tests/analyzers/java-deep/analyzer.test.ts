import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JavaDeepAnalyzer, inferJavaClasspath } from "../../../src/analyzers/java-deep/analyzer.js";
import { loadJavaClasspathSymbols } from "../../../src/analyzers/java-deep/classpath.js";
import { symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const overloadRoot = path.resolve(here, "../../fixtures/java-calls-overload");
const overloadFiles = ["com/app/Client.java", "com/util/Helper.java"];
const crossRoot = path.resolve(here, "../../fixtures/java-deep-crossroot");
const crossFiles = [
  "app/src/main/java/com/app/Controller.java",
  "lib/src/main/java/com/lib/Operations.java",
  "lib/src/main/java/com/lib/Service.java",
];
const nestedTypesRoot = path.resolve(here, "../../fixtures/java-deep-nested-types");
const nestedTypesFiles = ["com/app/Outer.java", "com/app/UsesNested.java"];
const composedRoutesRoot = path.resolve(here, "../../fixtures/java-deep-composed-routes");
const composedRoutesFiles = [
  "com/acme/api/GeneralApi.java",
  "com/acme/api/AutoJobPostMapping.java",
  "com/acme/api/AliasPutMapping.java",
  "com/acme/CropController.java",
];
const advancedRoot = path.resolve(here, "../../fixtures/java-deep-advanced");
const advancedFiles = [
  "com/app/TaskService.java",
  "com/app/BaseWorker.java",
  "com/app/Worker.java",
  "com/app/Helper.java",
  "com/app/Factory.java",
  "com/app/Widget.java",
  "com/app/Runner.java",
];
const recordsRoot = path.resolve(here, "../../fixtures/java-records");
const recordFiles = ["com/app/Event.java", "com/app/Payload.java", "com/app/UserEvent.java"];
const sameClassLambdaRoot = path.resolve(here, "../../fixtures/java-deep-sameclass-lambda");
const sameClassLambdaFiles = [
  "com/app/Handler.java",
  "com/app/Listener.java",
  "com/app/Log.java",
  "com/app/Result.java",
  "com/app/RunnableContext.java",
  "com/app/Settings.java",
  "com/app/Task.java",
];
const nodeKeyCollisionRoot = path.resolve(here, "../../fixtures/java-deep-nodekey-collision");
const nodeKeyCollisionFiles = ["com/app/A.java", "com/app/B.java"];
const selfRecursiveRoot = path.resolve(here, "../../fixtures/java-deep-self-recursive");
const selfRecursiveFiles = ["com/app/Loop.java"];

function encodeClassWithMethods(p: {
  thisClass: string;
  methods: { name: string; descriptor: string }[];
}): Uint8Array {
  const bytes: number[] = [];
  const u1 = (v: number) => bytes.push(v & 0xff);
  const u2 = (v: number) => bytes.push((v >> 8) & 0xff, v & 0xff);
  const u4 = (v: number) =>
    bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  const utf8 = (s: string) => {
    const enc = new TextEncoder().encode(s);
    u1(1);
    u2(enc.length);
    for (const b of enc) u1(b);
  };
  const classConst = (utfIndex: number) => {
    u1(7);
    u2(utfIndex);
  };

  u4(0xcafebabe);
  u2(0);
  u2(52);

  let idx = 1;
  const thisUtf = idx++;
  const thisClass = idx++;
  const superUtf = idx++;
  const superClass = idx++;
  const methodIndexes = p.methods.map((method) => ({
    name: idx++,
    descriptor: idx++,
    method,
  }));
  u2(idx);

  utf8(p.thisClass.replace(/\./g, "/"));
  classConst(thisUtf);
  utf8("java/lang/Object");
  classConst(superUtf);
  for (const method of methodIndexes) {
    utf8(method.method.name);
    utf8(method.method.descriptor);
  }

  u2(0x0421); // ACC_PUBLIC | ACC_SUPER | ACC_ABSTRACT
  u2(thisClass);
  u2(superClass);
  u2(0); // interfaces
  u2(0); // fields
  u2(methodIndexes.length);
  for (const method of methodIndexes) {
    u2(0x0401); // ACC_PUBLIC | ACC_ABSTRACT
    u2(method.name);
    u2(method.descriptor);
    u2(0); // attributes
  }
  u2(0); // attributes
  return new Uint8Array(bytes);
}

function encodeStoredZip(entries: Record<string, Uint8Array>): Uint8Array {
  const bytes: number[] = [];
  const central: number[] = [];
  const u2 = (out: number[], v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u4 = (out: number[], v: number) =>
    out.push(v & 0xff, (v >> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const writeName = (out: number[], name: Uint8Array) => {
    for (const b of name) out.push(b);
  };

  for (const [name, data] of Object.entries(entries)) {
    const encodedName = new TextEncoder().encode(name);
    const localOffset = bytes.length;
    u4(bytes, 0x04034b50);
    u2(bytes, 20);
    u2(bytes, 0);
    u2(bytes, 0);
    u2(bytes, 0);
    u2(bytes, 0);
    u4(bytes, 0);
    u4(bytes, data.length);
    u4(bytes, data.length);
    u2(bytes, encodedName.length);
    u2(bytes, 0);
    writeName(bytes, encodedName);
    for (const b of data) bytes.push(b);

    u4(central, 0x02014b50);
    u2(central, 20);
    u2(central, 20);
    u2(central, 0);
    u2(central, 0);
    u2(central, 0);
    u2(central, 0);
    u4(central, 0);
    u4(central, data.length);
    u4(central, data.length);
    u2(central, encodedName.length);
    u2(central, 0);
    u2(central, 0);
    u2(central, 0);
    u2(central, 0);
    u4(central, 0);
    u4(central, localOffset);
    writeName(central, encodedName);
  }

  const centralOffset = bytes.length;
  bytes.push(...central);
  u4(bytes, 0x06054b50);
  u2(bytes, 0);
  u2(bytes, 0);
  u2(bytes, Object.keys(entries).length);
  u2(bytes, Object.keys(entries).length);
  u4(bytes, central.length);
  u4(bytes, centralOffset);
  u2(bytes, 0);
  return new Uint8Array(bytes);
}

describe("JavaDeepAnalyzer", () => {
  it("uses pure TypeScript source semantics to resolve an overloaded Java call exactly", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      overloadRoot,
      overloadFiles,
    );

    expect(result.tier).toBe("deep");
    expect(result.nodes.find((n) => n.id === "com/app/Client.java")?.tier).toBe("deep");
    expect(
      result.nodes.some((n) => n.kind === "Method" && n.qualifiedName === "Helper.format(int)"),
    ).toBe(true);
    expect(
      result.nodes.some((n) => n.kind === "Method" && n.qualifiedName === "Helper.format(String)"),
    ).toBe(true);

    const from = symbolId({ file: "com/app/Client.java", qualifiedName: "Client.run" });
    const toInt = symbolId({ file: "com/util/Helper.java", qualifiedName: "Helper.format(int)" });
    const toStringOverload = symbolId({
      file: "com/util/Helper.java",
      qualifiedName: "Helper.format(String)",
    });
    expect(result.edges.some((e) => e.kind === "Calls" && e.from === from && e.to === toInt)).toBe(
      true,
    );
    expect(
      result.edges.some((e) => e.kind === "Calls" && e.from === from && e.to === toStringOverload),
    ).toBe(false);
    expect(result.resolution?.callsResolved).toBe(1);
  });

  it("falls back to the Java baseline result when source and bytecode paths both fail", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(overloadRoot, [
      "missing.java",
    ]);

    expect(result.tier).toBe("baseline");
    expect(result.nodes).toEqual([]);
  });

  it("resolves imported supertypes across source roots and calls through fields", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      crossRoot,
      crossFiles,
    );

    const controller = symbolId({
      file: "app/src/main/java/com/app/Controller.java",
      qualifiedName: "Controller",
    });
    const service = symbolId({
      file: "lib/src/main/java/com/lib/Service.java",
      qualifiedName: "Service",
    });
    const exportMethod = symbolId({
      file: "app/src/main/java/com/app/Controller.java",
      qualifiedName: "Controller.export",
    });
    const exportMarkdown = symbolId({
      file: "lib/src/main/java/com/lib/Operations.java",
      qualifiedName: "Operations.exportMarkdown",
    });
    const finish = symbolId({
      file: "app/src/main/java/com/app/Controller.java",
      qualifiedName: "Controller.finish",
    });

    expect(
      result.edges.some(
        (edge) => edge.kind === "Implements" && edge.from === controller && edge.to === service,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === exportMethod && edge.to === exportMarkdown,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === exportMethod && edge.to === finish,
      ),
    ).toBe(true);
  });

  it("resolves partially-qualified nested class parameter types", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      nestedTypesRoot,
      nestedTypesFiles,
    );

    const run = symbolId({
      file: "com/app/UsesNested.java",
      qualifiedName: "UsesNested.run",
    });
    const inner = symbolId({
      file: "com/app/Outer.java",
      qualifiedName: "Outer.Inner",
    });
    const render = symbolId({
      file: "com/app/Outer.java",
      qualifiedName: "Outer.Inner.render",
    });

    expect(
      result.edges.some(
        (edge) => edge.kind === "UsesType" && edge.from === run && edge.to === inner,
      ),
    ).toBe(true);
    expect(
      result.edges.some((edge) => edge.kind === "Calls" && edge.from === run && edge.to === render),
    ).toBe(true);
  });

  it("resolves same-class helper calls even when they cross a lambda body", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      sameClassLambdaRoot,
      sameClassLambdaFiles,
    );

    const executeTask = symbolId({
      file: "com/app/Handler.java",
      qualifiedName: "Handler.executeTask",
    });
    const executeWithSettings = symbolId({
      file: "com/app/Handler.java",
      qualifiedName: "Handler.executeWithSettings",
    });
    const runScripts = symbolId({
      file: "com/app/Handler.java",
      qualifiedName: "Handler.runScripts",
    });
    const processScript = symbolId({
      file: "com/app/Handler.java",
      qualifiedName: "Handler.processScript",
    });

    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "Calls" && edge.from === executeTask && edge.to === executeWithSettings,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "Calls" && edge.from === executeWithSettings && edge.to === runScripts,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === runScripts && edge.to === processScript,
      ),
    ).toBe(true);
  });

  it("counts self-recursive calls as resolved without emitting a self edge", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      selfRecursiveRoot,
      selfRecursiveFiles,
    );

    const count = symbolId({ file: "com/app/Loop.java", qualifiedName: "Loop.count" });

    expect(result.resolution?.callsTotal).toBe(1);
    expect(result.resolution?.callsResolved).toBe(1);
    expect(result.resolution?.unresolved.count).toBeUndefined();
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === count && edge.to === count,
      ),
    ).toBe(false);
  });

  it("resolves inherited methods, inferred locals, constructors, and diagnostics", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      advancedRoot,
      advancedFiles,
    );

    const run = symbolId({ file: "com/app/Runner.java", qualifiedName: "Runner.run" });
    const create = symbolId({ file: "com/app/Factory.java", qualifiedName: "Factory.create" });
    const step = symbolId({ file: "com/app/Helper.java", qualifiedName: "Helper.step" });
    const onlyWorker = symbolId({
      file: "com/app/Worker.java",
      qualifiedName: "Worker.onlyWorker",
    });
    const inherited = symbolId({
      file: "com/app/BaseWorker.java",
      qualifiedName: "BaseWorker.inherited",
    });
    const handle = symbolId({
      file: "com/app/TaskService.java",
      qualifiedName: "TaskService.handle",
    });
    const widgetCtor = symbolId({
      file: "com/app/Widget.java",
      qualifiedName: "Widget.Widget",
    });

    expect(
      result.edges.some((edge) => edge.kind === "Calls" && edge.from === run && edge.to === create),
    ).toBe(true);
    expect(
      result.edges.some((edge) => edge.kind === "Calls" && edge.from === run && edge.to === step),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === run && edge.to === onlyWorker,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === run && edge.to === inherited,
      ),
    ).toBe(true);
    expect(
      result.edges.some((edge) => edge.kind === "Calls" && edge.from === run && edge.to === handle),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Instantiates" && edge.from === run && edge.to === widgetCtor,
      ),
    ).toBe(true);
    expect(result.resolution?.callsResolved).toBeGreaterThanOrEqual(7);
    expect(result.resolution?.diagnostics?.["unknown-receiver"]).toBe(1);
  });

  it("does not arity-fallback when a non-matching argument type is known", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-known-mismatch-"));
    const previousStdlib = process.env.AMA_JAVA_INCLUDE_STDLIB;
    process.env.AMA_JAVA_INCLUDE_STDLIB = "0";
    try {
      const dir = path.join(root, "com/app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "Client.java"),
        `package com.app;
class Text {}
class NumberArg {}
class Service {
    void send(Text text) {}
}
class Client {
    void run(Service service, NumberArg arg) {
        service.send(arg);
    }
}
`,
      );

      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(root, [
        "com/app/Client.java",
      ]);
      const run = symbolId({ file: "com/app/Client.java", qualifiedName: "Client.run" });
      const send = symbolId({ file: "com/app/Client.java", qualifiedName: "Service.send" });

      expect(
        result.edges.some((edge) => edge.kind === "Calls" && edge.from === run && edge.to === send),
      ).toBe(false);
      expect(result.resolution?.diagnostics?.["type-mismatch"]).toBe(1);
    } finally {
      if (previousStdlib === undefined) process.env.AMA_JAVA_INCLUDE_STDLIB = undefined;
      else process.env.AMA_JAVA_INCLUDE_STDLIB = previousStdlib;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not use a later reassignment as the receiver type for the whole method", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-reassigned-local-"));
    const previousStdlib = process.env.AMA_JAVA_INCLUDE_STDLIB;
    process.env.AMA_JAVA_INCLUDE_STDLIB = "0";
    try {
      const dir = path.join(root, "com/app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "Client.java"),
        `package com.app;
interface Task {
    void run();
}
class Foo implements Task {
    public void run() {}
}
class Bar implements Task {
    public void run() {}
}
class Client {
    void execute() {
        Task task = new Foo();
        task.run();
        task = new Bar();
        task.run();
    }
}
`,
      );

      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(root, [
        "com/app/Client.java",
      ]);
      const execute = symbolId({ file: "com/app/Client.java", qualifiedName: "Client.execute" });
      const taskRun = symbolId({ file: "com/app/Client.java", qualifiedName: "Task.run" });
      const barRun = symbolId({ file: "com/app/Client.java", qualifiedName: "Bar.run" });

      expect(
        result.edges.some(
          (edge) => edge.kind === "Calls" && edge.from === execute && edge.to === taskRun,
        ),
      ).toBe(true);
      expect(
        result.edges.some(
          (edge) => edge.kind === "Calls" && edge.from === execute && edge.to === barRun,
        ),
      ).toBe(false);
    } finally {
      if (previousStdlib === undefined) process.env.AMA_JAVA_INCLUDE_STDLIB = undefined;
      else process.env.AMA_JAVA_INCLUDE_STDLIB = previousStdlib;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues hierarchy lookup past a child arity mismatch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-arity-hierarchy-"));
    const previousStdlib = process.env.AMA_JAVA_INCLUDE_STDLIB;
    process.env.AMA_JAVA_INCLUDE_STDLIB = "0";
    try {
      const dir = path.join(root, "com/app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "Client.java"),
        `package com.app;
class Base {
    void target(String value) {}
}
class Child extends Base {
    void target() {}
}
class Client {
    void run(Child child) {
        child.target("x");
    }
}
`,
      );

      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(root, [
        "com/app/Client.java",
      ]);
      const run = symbolId({ file: "com/app/Client.java", qualifiedName: "Client.run" });
      const baseTarget = symbolId({ file: "com/app/Client.java", qualifiedName: "Base.target" });

      expect(
        result.edges.some(
          (edge) => edge.kind === "Calls" && edge.from === run && edge.to === baseTarget,
        ),
      ).toBe(true);
    } finally {
      if (previousStdlib === undefined) process.env.AMA_JAVA_INCLUDE_STDLIB = undefined;
      else process.env.AMA_JAVA_INCLUDE_STDLIB = previousStdlib;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("labels implicit constructor instantiation edges as type-level fallbacks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-implicit-ctor-"));
    const previousStdlib = process.env.AMA_JAVA_INCLUDE_STDLIB;
    process.env.AMA_JAVA_INCLUDE_STDLIB = "0";
    try {
      const dir = path.join(root, "com/app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "Client.java"),
        `package com.app;
class DefaultThing {}
class Client {
    void run() {
        new DefaultThing();
    }
}
`,
      );

      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(root, [
        "com/app/Client.java",
      ]);
      const run = symbolId({ file: "com/app/Client.java", qualifiedName: "Client.run" });
      const defaultThing = symbolId({ file: "com/app/Client.java", qualifiedName: "DefaultThing" });
      const edge = result.edges.find(
        (candidate) =>
          candidate.kind === "Instantiates" &&
          candidate.from === run &&
          candidate.to === defaultThing,
      );

      expect(edge).toMatchObject({
        confidence: 0.6,
        strategy: "implicit-constructor",
      });
    } finally {
      if (previousStdlib === undefined) process.env.AMA_JAVA_INCLUDE_STDLIB = undefined;
      else process.env.AMA_JAVA_INCLUDE_STDLIB = previousStdlib;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("links Java method references and lambda callback bodies to their target methods", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-method-ref-"));
    const previousStdlib = process.env.AMA_JAVA_INCLUDE_STDLIB;
    process.env.AMA_JAVA_INCLUDE_STDLIB = "0";
    try {
      const dir = path.join(root, "com/app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "Client.java"),
        `package com.app;
interface Handler {
    void accept(Event event);
}
class Subscriber {
    void with(Handler handler) {}
}
class Event {}
class Worker {
    void handle(Event event) {}
}
class Client {
    void runMethodRef(Subscriber subscriber, Worker worker) {
        subscriber.with(this::handle);
        subscriber.with(Client::staticHandle);
        subscriber.with(worker::handle);
    }

    void runLambda(Subscriber subscriber) {
        subscriber.with(item -> handle(item));
    }

    void runAmbiguous(Subscriber subscriber) {
        subscriber.with(this::overloaded);
    }

    void handle(Event event) {}

    static void staticHandle(Event event) {}

    void overloaded(Event event) {}

    void overloaded(String value) {}
}
`,
      );

      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(root, [
        "com/app/Client.java",
      ]);
      const runMethodRef = symbolId({
        file: "com/app/Client.java",
        qualifiedName: "Client.runMethodRef",
      });
      const runLambda = symbolId({
        file: "com/app/Client.java",
        qualifiedName: "Client.runLambda",
      });
      const runAmbiguous = symbolId({
        file: "com/app/Client.java",
        qualifiedName: "Client.runAmbiguous",
      });
      const handle = symbolId({ file: "com/app/Client.java", qualifiedName: "Client.handle" });
      const staticHandle = symbolId({
        file: "com/app/Client.java",
        qualifiedName: "Client.staticHandle",
      });
      const workerHandle = symbolId({
        file: "com/app/Client.java",
        qualifiedName: "Worker.handle",
      });
      const overloadedEvent = symbolId({
        file: "com/app/Client.java",
        qualifiedName: "Client.overloaded(Event)",
      });
      const overloadedString = symbolId({
        file: "com/app/Client.java",
        qualifiedName: "Client.overloaded(String)",
      });

      for (const target of [handle, staticHandle, workerHandle]) {
        expect(
          result.edges.find(
            (edge) => edge.kind === "Calls" && edge.from === runMethodRef && edge.to === target,
          ),
        ).toMatchObject({
          provenance: "heuristic",
          confidence: 0.5,
          strategy: "heuristic",
        });
      }
      expect(
        result.edges.some(
          (edge) => edge.kind === "Calls" && edge.from === runLambda && edge.to === handle,
        ),
      ).toBe(true);
      expect(
        result.edges.some(
          (edge) =>
            edge.kind === "Calls" &&
            edge.from === runAmbiguous &&
            (edge.to === overloadedEvent || edge.to === overloadedString),
        ),
      ).toBe(false);
      expect(result.resolution?.diagnostics?.["ambiguous-overload"]).toBeGreaterThanOrEqual(1);
    } finally {
      if (previousStdlib === undefined) process.env.AMA_JAVA_INCLUDE_STDLIB = undefined;
      else process.env.AMA_JAVA_INCLUDE_STDLIB = previousStdlib;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keys method source ranges by file when attributing call sites", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      nodeKeyCollisionRoot,
      nodeKeyCollisionFiles,
    );

    const aRun = symbolId({ file: "com/app/A.java", qualifiedName: "A.run" });
    const aHelper = symbolId({ file: "com/app/A.java", qualifiedName: "A.helper" });
    const bRun = symbolId({ file: "com/app/B.java", qualifiedName: "B.run" });
    const bHelper = symbolId({ file: "com/app/B.java", qualifiedName: "B.helper" });

    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === aRun && edge.to === aHelper,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === bRun && edge.to === bHelper,
      ),
    ).toBe(false);
  });

  it("chunks oversized Java source batches instead of dropping the whole language to baseline", async () => {
    const previousChunkSize = process.env.AMA_JAVA_DEEP_CHUNK_SIZE;
    process.env.AMA_JAVA_DEEP_CHUNK_SIZE = "1";
    try {
      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
        nodeKeyCollisionRoot,
        nodeKeyCollisionFiles,
      );
      const aRun = symbolId({ file: "com/app/A.java", qualifiedName: "A.run" });
      const aHelper = symbolId({ file: "com/app/A.java", qualifiedName: "A.helper" });

      expect(result.tier).toBe("deep");
      expect(result.resolution?.diagnostics?.["chunked-analysis"]).toBe(2);
      expect(
        result.edges.some(
          (edge) => edge.kind === "Calls" && edge.from === aRun && edge.to === aHelper,
        ),
      ).toBe(true);
    } finally {
      if (previousChunkSize === undefined) process.env.AMA_JAVA_DEEP_CHUNK_SIZE = undefined;
      else process.env.AMA_JAVA_DEEP_CHUNK_SIZE = previousChunkSize;
    }
  });

  it("keeps huge Java batches baseline by default instead of attempting an unsafe deep pass", async () => {
    const previousMaxFiles = process.env.AMA_JAVA_DEEP_MAX_FILES;
    const previousChunkSize = process.env.AMA_JAVA_DEEP_CHUNK_SIZE;
    process.env.AMA_JAVA_DEEP_MAX_FILES = "1";
    process.env.AMA_JAVA_DEEP_CHUNK_SIZE = undefined;
    try {
      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
        nodeKeyCollisionRoot,
        nodeKeyCollisionFiles,
      );

      expect(result.tier).toBe("baseline");
      expect(result.resolution).toBeUndefined();
    } finally {
      if (previousMaxFiles === undefined) process.env.AMA_JAVA_DEEP_MAX_FILES = undefined;
      else process.env.AMA_JAVA_DEEP_MAX_FILES = previousMaxFiles;
      if (previousChunkSize === undefined) process.env.AMA_JAVA_DEEP_CHUNK_SIZE = undefined;
      else process.env.AMA_JAVA_DEEP_CHUNK_SIZE = previousChunkSize;
    }
  });

  it("resolves Spring routes declared through composed annotations", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      composedRoutesRoot,
      composedRoutesFiles,
    );

    const crop = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "CropController.crop",
    });
    const status = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "CropController.status",
    });
    const alias = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "CropController.alias",
    });
    const cropRoute = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "POST /api/v1/general/crop",
    });
    const statusRoute = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "GET /api/v1/general/status",
    });
    const aliasRoute = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "PUT /api/v1/general/alias",
    });
    const shortStatusRoute = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "GET /status",
    });

    expect(
      result.edges.some(
        (edge) => edge.kind === "References" && edge.from === cropRoute && edge.to === crop,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "References" && edge.from === statusRoute && edge.to === status,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "References" && edge.from === aliasRoute && edge.to === alias,
      ),
    ).toBe(true);
    expect(result.nodes.some((node) => node.id === shortStatusRoute)).toBe(false);
  });

  it("infers Java classpath entries from env and common build outputs", () => {
    const root = path.join(advancedRoot, "tmp-classpath");
    const targetClasses = path.join(root, "target/classes");
    const gradleClasses = path.join(root, "build/classes/java/main");
    const targetDependency = path.join(root, "target/dependency");
    const buildLibs = path.join(root, "build/libs");
    fs.mkdirSync(targetClasses, { recursive: true });
    fs.mkdirSync(gradleClasses, { recursive: true });
    fs.mkdirSync(targetDependency, { recursive: true });
    fs.mkdirSync(buildLibs, { recursive: true });
    fs.writeFileSync(path.join(targetDependency, "dep.jar"), "");
    fs.writeFileSync(path.join(buildLibs, "app.jar"), "");
    try {
      const entries = inferJavaClasspath(root, "/custom/classes").split(path.delimiter).sort();
      expect(entries).toEqual(
        [
          "/custom/classes",
          path.join(buildLibs, "app.jar"),
          gradleClasses,
          path.join(targetDependency, "dep.jar"),
          targetClasses,
        ].sort(),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves source calls into methods loaded from dependency jars", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-deep-jar-"));
    const previousStdlib = process.env.AMA_JAVA_INCLUDE_STDLIB;
    process.env.AMA_JAVA_INCLUDE_STDLIB = "0";
    try {
      const sourceDir = path.join(root, "com/app");
      const libsDir = path.join(root, "build/libs");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(libsDir, { recursive: true });
      fs.writeFileSync(
        path.join(libsDir, "dependency.jar"),
        encodeStoredZip({
          "com/dep/ExternalLib.class": encodeClassWithMethods({
            thisClass: "com.dep.ExternalLib",
            methods: [{ name: "convert", descriptor: "(Ljava/lang/String;)Ljava/lang/String;" }],
          }),
        }),
      );
      fs.writeFileSync(
        path.join(sourceDir, "Client.java"),
        `package com.app;
import com.dep.ExternalLib;

class Client {
    String run(ExternalLib lib) {
        return lib.convert("x");
    }
}
`,
      );

      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(root, [
        "com/app/Client.java",
      ]);
      const from = symbolId({ file: "com/app/Client.java", qualifiedName: "Client.run" });
      const externalType = result.nodes.find((node) => node.id === "java:com.dep.ExternalLib");
      const externalMethod = result.nodes.find(
        (node) =>
          node.file === "java:com.dep.ExternalLib" &&
          node.qualifiedName === "com.dep.ExternalLib.convert",
      );

      expect(externalType?.kind).toBe("Class");
      expect(externalType?.external).toBe(true);
      expect(externalMethod?.kind).toBe("Method");
      expect(externalMethod?.external).toBe(true);
      expect(
        result.edges.some(
          (edge) =>
            edge.kind === "UsesType" &&
            edge.from === from &&
            edge.to === externalType?.id &&
            edge.strategy === "exact-type" &&
            edge.confidence === 1,
        ),
      ).toBe(true);
      expect(
        result.edges.some(
          (edge) =>
            edge.kind === "Calls" &&
            edge.from === from &&
            edge.to === externalMethod?.id &&
            edge.strategy === "exact-type" &&
            edge.confidence === 1,
        ),
      ).toBe(true);
    } finally {
      if (previousStdlib === undefined) process.env.AMA_JAVA_INCLUDE_STDLIB = undefined;
      else process.env.AMA_JAVA_INCLUDE_STDLIB = previousStdlib;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips dependency archives and class entries over configured size caps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-classpath-caps-"));
    const previousArchiveCap = process.env.AMA_JAVA_CLASSPATH_ARCHIVE_MAX_BYTES;
    const previousEntryCap = process.env.AMA_JAVA_CLASSPATH_ENTRY_MAX_BYTES;
    try {
      const jar = path.join(root, "dependency.jar");
      fs.writeFileSync(
        jar,
        encodeStoredZip({
          "com/dep/ExternalLib.class": encodeClassWithMethods({
            thisClass: "com.dep.ExternalLib",
            methods: [{ name: "convert", descriptor: "()V" }],
          }),
        }),
      );

      process.env.AMA_JAVA_CLASSPATH_ARCHIVE_MAX_BYTES = "1";
      process.env.AMA_JAVA_CLASSPATH_ENTRY_MAX_BYTES = "100000";
      expect(loadJavaClasspathSymbols([jar]).types).toEqual([]);

      process.env.AMA_JAVA_CLASSPATH_ARCHIVE_MAX_BYTES = "100000";
      process.env.AMA_JAVA_CLASSPATH_ENTRY_MAX_BYTES = "1";
      expect(loadJavaClasspathSymbols([jar]).types).toEqual([]);
    } finally {
      if (previousArchiveCap === undefined) {
        process.env.AMA_JAVA_CLASSPATH_ARCHIVE_MAX_BYTES = undefined;
      } else {
        process.env.AMA_JAVA_CLASSPATH_ARCHIVE_MAX_BYTES = previousArchiveCap;
      }
      if (previousEntryCap === undefined) {
        process.env.AMA_JAVA_CLASSPATH_ENTRY_MAX_BYTES = undefined;
      } else {
        process.env.AMA_JAVA_CLASSPATH_ENTRY_MAX_BYTES = previousEntryCap;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps generated call-heavy methods inside a local-typing performance guardrail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-deep-perf-"));
    try {
      const dir = path.join(root, "com/app");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "Helper.java"),
        'package com.app; class Helper { String step() { return "ok"; } }\n',
      );
      const calls = Array.from({ length: 350 }, () => "        helper.step();").join("\n");
      fs.writeFileSync(
        path.join(dir, "Generated.java"),
        `package com.app;
class Generated {
    String run() {
        Helper helper = new Helper();
${calls}
        return "ok";
    }
}
`,
      );

      const start = performance.now();
      const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(root, [
        "com/app/Helper.java",
        "com/app/Generated.java",
      ]);
      const durationMs = performance.now() - start;

      expect(result.resolution?.callsResolved).toBeGreaterThanOrEqual(350);
      expect(durationMs).toBeLessThan(3000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexes records as class-like semantic types", async () => {
    const result = await new JavaDeepAnalyzer("ama-no-such-javac-binary").analyze(
      recordsRoot,
      recordFiles,
    );

    const event = symbolId({ file: "com/app/Event.java", qualifiedName: "Event" });
    const payloadName = symbolId({ file: "com/app/Payload.java", qualifiedName: "Payload.name" });
    const userEvent = symbolId({ file: "com/app/UserEvent.java", qualifiedName: "UserEvent" });
    const payload = symbolId({
      file: "com/app/UserEvent.java",
      qualifiedName: "UserEvent.payload",
    });
    const label = symbolId({ file: "com/app/UserEvent.java", qualifiedName: "UserEvent.label" });

    expect(result.nodes.find((node) => node.id === userEvent)?.kind).toBe("Class");
    expect(result.nodes.find((node) => node.id === payload)?.kind).toBe("Property");
    expect(
      result.edges.some(
        (edge) => edge.kind === "Implements" && edge.from === userEvent && edge.to === event,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "Calls" && edge.from === label && edge.to === payloadName,
      ),
    ).toBe(true);
  });
});
