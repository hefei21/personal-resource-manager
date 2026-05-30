<template>
  <div class="login-container">
    <div class="login-box">
      <h1>雨的空间</h1>
      <form @submit.prevent="handleSubmit" class="login-form">
        <div class="form-item">
          <label class="form-label">用户名</label>
          <NativeInput
            v-model="formData.username"
            placeholder="请输入用户名"
            size="large"
          />
        </div>
        <div class="form-item">
          <label class="form-label">密码</label>
          <NativeInput
            v-model="formData.password"
            type="password"
            placeholder="请输入密码"
            size="large"
          />
        </div>
        <div class="form-item remember-row">
          <NativeCheckbox v-model="formData.remember">记住登录状态</NativeCheckbox>
        </div>
        <div class="form-item login-buttons">
          <NativeButton
            theme="primary"
            type="submit"
            size="large"
            :loading="loginLoading"
            class="login-btn"
          >
            登录
          </NativeButton>
          <NativeButton
            theme="default"
            size="large"
            :loading="guestLoading"
            @click="handleGuestLogin"
            class="login-btn guest-btn"
          >
            游客访问
          </NativeButton>
        </div>
      </form>
      <NativeAlert v-if="error" theme="error">{{ error }}</NativeAlert>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { NativeButton, NativeInput, NativeCheckbox, NativeAlert } from '@/components/native'

const router = useRouter()
const authStore = useAuthStore()

const loginLoading = ref(false)
const guestLoading = ref(false)
const error = ref('')

const formData = reactive({
  username: '',
  password: '',
  remember: true
})

async function handleSubmit() {
  if (!formData.username) {
    error.value = '请输入用户名'
    return
  }
  if (!formData.password) {
    error.value = '请输入密码'
    return
  }

  try {
    loginLoading.value = true
    error.value = ''
    const result = await authStore.login(
      formData.username,
      formData.password,
      formData.remember
    )
    if (result.success) {
      window.location.href = '/'
    } else {
      error.value = result.message
    }
  } catch (err) {
    error.value = '登录失败，请检查用户名和密码'
  } finally {
    loginLoading.value = false
  }
}

async function handleGuestLogin() {
  try {
    guestLoading.value = true
    error.value = ''
    const result = await authStore.guestLogin()
    if (result.success) {
      window.location.href = '/'
    } else {
      error.value = result.message || '游客登录失败'
    }
  } catch (err) {
    error.value = '游客登录失败'
  } finally {
    guestLoading.value = false
  }
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  min-height: 100dvh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 16px;
  box-sizing: border-box;
}

.login-box {
  background: white;
  padding: 28px 20px;
  border-radius: 16px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
  width: 100%;
  max-width: 360px;
}

.login-box h1 {
  text-align: center;
  margin-bottom: 24px;
  color: #333;
  font-size: 22px;
  font-weight: 600;
}

.login-form {
  margin-top: 16px;
}

.form-item {
  margin-bottom: 18px;
}

.form-item:last-child {
  margin-bottom: 0;
}

.remember-row {
  margin-bottom: 24px;
}

.form-label {
  display: block;
  margin-bottom: 8px;
  font-size: 15px;
  color: #333;
  font-weight: 500;
}

.login-buttons {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-btn {
  width: 100%;
  justify-content: center;
  min-height: 48px;
  font-size: 16px;
}

.guest-btn {
  opacity: 0.9;
}
</style>
