<template>
  <router-view v-slot="{ Component, route }">
    <!-- Only the search workspace is retained; logout destroys its owning shell.
         Keep content in memory, never in URLs, history.state or browser storage. -->
    <KeepAlive include="Search" :max="3">
      <component :is="Component" :key="route.name === 'Search' ? route.fullPath : undefined" />
    </KeepAlive>
  </router-view>
</template>
