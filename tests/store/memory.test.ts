import { InMemoryStore } from "../../src/store/memory.js";
import { runStoreContract } from "./contract.js";

runStoreContract("InMemoryStore", () => new InMemoryStore());
