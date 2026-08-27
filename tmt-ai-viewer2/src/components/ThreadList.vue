<script setup lang="ts">
import { useStore } from "../store";
const store = useStore();

function ago(ts: string) {
  if (!ts) return "";
  const d = (Date.now() - new Date(ts + (ts.endsWith("Z") ? "" : "Z")).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}
</script>

<template>
  <div class="list-pane">
    <div class="list-head">
      <div class="sort-seg">
        <button
          class="seg-btn"
          :class="{ active: store.threadSort === 'recent' }"
          title="Most recent response / activity first"
          @click="store.setThreadSort('recent')"
        >
          Recent
        </button>
        <button
          class="seg-btn"
          :class="{ active: store.threadSort === 'newest' }"
          title="Newest request first"
          @click="store.setThreadSort('newest')"
        >
          Newest
        </button>
        <button
          class="seg-btn"
          :class="{ active: store.threadSort === 'oldest' }"
          title="Oldest request first"
          @click="store.setThreadSort('oldest')"
        >
          Oldest
        </button>
      </div>
      <button
        class="unread-filter"
        :class="{ active: store.unreadOnly }"
        :disabled="!store.unreadCount && !store.unreadOnly"
        title="Show only requests you haven't read yet"
        @click="store.toggleUnreadOnly()"
      >
        Unread{{ store.unreadCount ? ` (${store.unreadCount})` : "" }}
      </button>
    </div>

    <div v-if="!store.threads.length" class="empty">
      No requests yet. Type a prompt above to start one.
    </div>
    <div v-else-if="!store.sortedThreads.length" class="empty">
      Nothing unread.
    </div>
    <div
      v-for="t in store.sortedThreads"
      :key="t.id"
      class="thread-item"
      :class="{ active: t.id === store.currentThreadId, unread: t.unread }"
      @click="store.openThread(t.id)"
    >
      <div class="title">
        {{ t.title || "(untitled)" }}
        <span v-if="t.status === 'awaiting'" class="await-badge">answer?</span>
      </div>
      <div class="meta">
        <span v-if="t.status === 'running'" class="run-dot"></span>
        <span v-else class="dot" :class="t.status"></span>
        <span>{{ t.status }}</span>
        <span>· {{ ago(t.updated_at) }} ago</span>
        <button
          class="mark-btn"
          :title="t.unread ? 'Mark as read' : 'Mark as unread to come back later'"
          @click.stop="t.unread ? store.markRead(t.id) : store.markUnread(t.id)"
        >
          {{ t.unread ? "✓ read" : "◦ unread" }}
        </button>
      </div>
    </div>
  </div>
</template>
