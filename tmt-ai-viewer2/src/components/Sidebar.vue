<script setup lang="ts">
import { useStore } from "../store";
const store = useStore();
</script>

<template>
  <aside id="sidebar">
    <h1>tmt-ai</h1>
    <div class="side-actions">
      <button class="btn" @click="store.toggleTheme()" :title="'Toggle theme'">
        {{ store.theme === "light" ? "🌙" : "☀️" }}
      </button>
      <button v-if="store.authEnabled" class="btn" @click="store.doLogout()">Logout</button>
    </div>
    <div class="proj-sort">
      <button
        class="seg-btn"
        :class="{ active: store.projectSort === 'recent' }"
        title="Most recently active projects first"
        @click="store.setProjectSort('recent')"
      >
        Recent
      </button>
      <button
        class="seg-btn"
        :class="{ active: store.projectSort === 'alpha' }"
        title="Sort projects A–Z"
        @click="store.setProjectSort('alpha')"
      >
        A–Z
      </button>
    </div>
    <nav class="project-list">
      <button
        v-for="p in store.sortedProjects"
        :key="p.name"
        class="project-item"
        :class="{ active: p.name === store.currentProject }"
        @click="store.selectProject(p.name)"
      >
        <span class="name">{{ p.name }}</span>
        <span v-if="p.running" class="run-badge">▶{{ p.running }}</span>
        <span v-if="p.unread" class="badge">{{ p.unread }}</span>
        <span class="total">{{ p.total }}</span>
      </button>
    </nav>
  </aside>
</template>
