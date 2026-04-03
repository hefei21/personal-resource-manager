<template>
  <div class="login-container">
    <div class="login-box">
      <h1>雨的空间</h1>
      <t-form
        ref="formRef"
        :data="formData"
        :rules="rules"
        @submit="handleSubmit"
        class="login-form"
      >
        <t-form-item name="username" label="用户名">
          <t-input
            v-model="formData.username"
            placeholder="请输入用户名"
            size="large"
          />
        </t-form-item>
        <t-form-item name="password" label="密码">
          <t-input
            v-model="formData.password"
            type="password"
            placeholder="请输入密码"
            size="large"
          />
        </t-form-item>
        <t-form-item>
          <t-checkbox v-model="formData.remember">记住登录状态</t-checkbox>
        </t-form-item>
        <t-form-item>
          <t-button
            theme="primary"
            type="submit"
            size="large"
            block
            :loading="loading"
          >
            登录
          </t-button>
        </t-form-item>
        <t-form-item>
          <t-button
            theme="default"
            size="large"
            block
            @click="handleGuestLogin"
          >
            游客访问
          </t-button>
        </t-form-item>
      </t-form>
      <t-alert v-if="error" theme="error" :message="error" />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { MessagePlugin } from 'tdesign-vue-next'

const router = useRouter()
const authStore = useAuthStore()

const formRef = ref()
const loading = ref(false)
const error = ref('')

const formData = reactive({
  username: '',
  password: '',
  remember: true
})

const rules = {
  username: [{ required: true, message: '请输入用户名', type: 'error' }],
  password: [{ required: true, message: '请输入密码', type: 'error' }]
}

async function handleSubmit() {
  try {
    loading.value = true
    error.value = ''

    const result = await authStore.login(
      formData.username,
      formData.password,
      formData.remember
    )

    if (result.success) {
      MessagePlugin.success('登录成功')
      // 使用 window.location.href 确保页面完全刷新
      window.location.href = '/'
    } else {
      error.value = result.message
    }
  } catch (err) {
    error.value = '登录失败，请检查用户名和密码'
  } finally {
    loading.value = false
  }
}

async function handleGuestLogin() {
  try {
    loading.value = true
    error.value = ''
    
    const result = await authStore.guestLogin()
    
    if (result.success) {
      MessagePlugin.info('欢迎游客访问')
      window.location.href = '/'
    } else {
      error.value = result.message || '游客登录失败'
    }
  } catch (err) {
    error.value = '游客登录失败'
  } finally {
    loading.value = false
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

.login-form :deep(.t-form-item) {
  margin-bottom: 20px;
  animation: fadeInUp 0.6s ease-out backwards;
}

.login-form :deep(.t-form-item:nth-child(1)) {
  animation-delay: 0.1s;
}

.login-form :deep(.t-form-item:nth-child(2)) {
  animation-delay: 0.2s;
}

.login-form :deep(.t-form-item:nth-child(3)) {
  animation-delay: 0.3s;
}

.login-form :deep(.t-form-item:nth-child(4)) {
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

.login-form :deep(.t-button) {
  transition: all 0.3s ease;
}

.login-form :deep(.t-button:hover) {
  transform: translateY(-2px);
  box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
}

.login-form :deep(.t-button:active) {
  transform: translateY(0);
}

.login-form :deep(.t-input) {
  transition: all 0.3s ease;
}

.login-form :deep(.t-input:hover) {
  border-color: #667eea;
}

.login-form :deep(.t-input:focus) {
  border-color: #764ba2;
  box-shadow: 0 0 0 3px rgba(118, 75, 162, 0.1);
}

/* 按钮容器居中 */
.login-form :deep(.t-form-item:last-child .t-form-item__content) {
  justify-content: center;
}

.login-form :deep(.t-space) {
  width: 100%;
  justify-content: center;
}
</style>
