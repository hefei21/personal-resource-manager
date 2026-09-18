<template>
  <EbookReaderDialog :model-value="visible" :book="book" :is-guest="isGuest" @update:model-value="value => { if (!value) emit('close') }" @closed="emit('progress-saved')" />
</template>

<script setup>
import EbookReaderDialog from '@/components/books/EbookReaderDialog.vue'

defineProps({ visible: Boolean, book: { type: Object, default: null }, isGuest: Boolean })
const emit = defineEmits(['close', 'progress-saved'])
</script>
