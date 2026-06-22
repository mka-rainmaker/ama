<script lang="ts">
import { helper } from "./helper";

const loadPanel = () => import("./Panel.svelte");
const msg = helper();
</script>

<button on:click={loadPanel}>{msg}</button>
