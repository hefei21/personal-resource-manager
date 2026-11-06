<template>
  <main class="login-container">
    <section class="login-box" aria-labelledby="login-title">
      <p class="login-eyebrow">个人资源工作台</p>
      <h1 id="login-title">雨的空间</h1>
      <p class="login-description">登录后继续整理、阅读与检索。</p>
      <form class="login-form" @submit.prevent="handleSubmit" :aria-busy="busy">
        <div class="form-item">
          <label for="login-username">用户名</label>
          <NativeInput id="login-username" v-model="form.username" name="username" autocomplete="username" placeholder="请输入用户名" :disabled="busy" required />
        </div>
        <div class="form-item">
          <label for="login-password">密码</label>
          <NativeInput id="login-password" v-model="form.password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" :disabled="busy" required />
        </div>
        <NativeCheckbox v-model="form.remember" :disabled="busy">记住登录状态</NativeCheckbox>
        <NativeAlert v-if="error" role="alert" theme="error">{{ error }}</NativeAlert>
        <NativeButton theme="primary" type="submit" :loading="loginLoading" :disabled="guestLoading">登录</NativeButton>
        <NativeButton variant="outline" :loading="guestLoading" :disabled="loginLoading" @click="handleGuestLogin">体验演示空间</NativeButton>
      </form>
      <p class="login-footnote">演示空间仅使用合成数据，与个人资料隔离。</p>
    </section>
  </main>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { NativeButton, NativeInput, NativeCheckbox, NativeAlert } from '@/components/native'

const authStore = useAuthStore()
const form = reactive({ username: '', password: '', remember: true })
const loginLoading = ref(false), guestLoading = ref(false), error = ref('')
const busy = computed(() => loginLoading.value || guestLoading.value)

async function handleSubmit() {
  if (busy.value) return
  if (!form.username || !form.password) { error.value = '请输入用户名和密码'; return }
  loginLoading.value = true
  error.value = ''
  try {
    const result = await authStore.login(form.username, form.password, form.remember)
    if (result.success) window.location.href = '/'
    else error.value = result.message || '登录失败，请检查用户名和密码'
  } catch {
    error.value = '登录失败，请检查网络后重试'
  } finally { loginLoading.value = false }
}

async function handleGuestLogin() {
  if (busy.value) return
  guestLoading.value = true
  error.value = ''
  try {
    const result = await authStore.guestLogin()
    if (result.success) window.location.href = '/demo'
    else error.value = result.message || '无法创建演示会话'
  } catch {
    error.value = '无法创建演示会话，请稍后重试'
  } finally { guestLoading.value = false }
}
</script>

<style scoped>
.login-container { display: grid; place-items: center; min-height: 100vh; min-height: 100dvh; padding: 32px 16px; background: var(--color-surface-page); }
.login-box { width: 100%; max-width: 440px; padding: 36px; border: 1px solid var(--color-border-default); border-radius: var(--radius-lg); background: var(--color-surface-raised); }
.login-eyebrow { margin: 0 0 8px; color: var(--color-primary); font-size: 13px; font-weight: 600; }
h1 { margin: 0; color: var(--color-text-primary); font-size: 28px; letter-spacing: -.04em; }
.login-description, .login-footnote { color: var(--color-text-secondary); line-height: 1.6; }
.login-description { margin: 12px 0 28px; font-size: 14px; }
.login-form { display: grid; gap: 16px; }
.form-item { display: grid; gap: 8px; min-width: 0; }
.form-item label { color: var(--color-text-primary); font-size: 14px; font-weight: 600; }
.login-form > :deep(.native-btn) { width: 100%; justify-content: center; min-height: var(--control-height-touch); }
.login-footnote { margin: 24px 0 0; font-size: 12px; }
@media (max-width: 768px) { .login-box { padding: 24px; } h1 { font-size: 24px; } }
</style>
