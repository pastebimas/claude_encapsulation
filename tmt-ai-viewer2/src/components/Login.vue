<script setup lang="ts">
import { ref } from "vue";
import { useStore } from "../store";

const store = useStore();
const password = ref("");
const err = ref("");
const busy = ref(false);

async function submit() {
  err.value = "";
  busy.value = true;
  try {
    await store.doLogin(password.value);
  } catch (e: any) {
    err.value = e?.unauthorized ? "Wrong password" : "Login failed";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>tmt-ai</h1>
      <input
        type="password"
        v-model="password"
        placeholder="Password"
        @keyup.enter="submit"
        autofocus
      />
      <div class="err">{{ err }}</div>
      <button class="btn primary" style="width: 100%" :disabled="busy" @click="submit">
        Log in
      </button>
    </div>
  </div>
</template>
