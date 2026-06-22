<template>
  <div>{{ msg }}</div>
  <Card />
</template>

<script setup lang="ts">
import { helper } from "./helper";
import Card from "./Card.vue";

const msg = helper();
</script>

<style scoped>
div {
  color: red;
}
</style>
