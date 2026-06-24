import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JavaDeepAnalyzer } from "../../../src/analyzers/java-deep/analyzer.js";
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
  "com/acme/CropController.java",
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
    const cropRoute = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "POST /api/v1/general/crop",
    });
    const statusRoute = symbolId({
      file: "com/acme/CropController.java",
      qualifiedName: "GET /api/v1/general/status",
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
    expect(result.nodes.some((node) => node.id === shortStatusRoute)).toBe(false);
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
