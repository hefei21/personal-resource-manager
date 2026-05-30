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
        <div class="form-item">
          <NativeCheckbox v-model="formData.remember">记住登录状态</NativeCheckbox>
        </div>
        <div class="form-item login-buttons">
          <div class="button-group">
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
              class="login-btn"
            >
              游客访问
            </NativeButton>
          </div>
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
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  animation: gradientShift 10s ease infinite;
  background-size: 200% 200%;
}

@keyframes gradientShift {
  0%, 100% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
}

.login-box {
  background: white;
  padding: 40px;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  width: 100%;
  max-width: 400px;
  animation: slideUp 0.6s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(30px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.login-box h1 {
  text-align: center;
  margin-bottom: 30px;
  color: #333;
  font-size: 24px;
  animation: fadeIn 1s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.login-form {
  margin-top: 20px;
}

.form-item {
  margin-bottom: 20px;
  animation: fadeInUp 0.6s ease-out backwards;
}

.form-item:nth-child(1) {
  animation-delay: 0.1s;
}

.form-item:nth-child(2) {
  animation-delay: 0.2s;
}

.form-item:nth-child(3) {
  animation-delay: 0.3s;
}

.form-item:nth-child(4) {
  animation-delay: 0.4s;
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.form-label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  color: #333;
  font-weight: 500;
}

.login-buttons .button-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.login-buttons .login-btn {
  width: 100%;
  justify-content: center;
}
</style>
