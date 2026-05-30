<template>
  <div class="dashboard mobile-dashboard">
    <!-- 统计卡片：使用 CSS Grid 布局 -->
    <div class="stats-grid">
      <!-- 文档 -->
      <div class="stat-card">
        <div class="stat-card-title">文档</div>
        <div class="stat-item">
          <div class="stat-value">{{ stats.documents }}</div>
          <div class="stat-label">文档总数</div>
        </div>
      </div>
      <!-- 博客 -->
      <div class="stat-card">
        <div class="stat-card-title">博客</div>
        <div class="stat-item">
          <div class="stat-value">{{ stats.blog?.total || 0 }}</div>
          <div class="stat-label">文章总数</div>
        </div>
      </div>
      <!-- 音乐 -->
      <div class="stat-card">
        <div class="stat-card-title">音乐</div>
        <div class="stat-item">
          <div class="stat-value">{{ stats.music }}</div>
          <div class="stat-label">音乐总数</div>
        </div>
      </div>
      <!-- 书籍 -->
      <div class="stat-card">
        <div class="stat-card-title">书籍</div>
        <div class="stat-item">
          <div class="stat-value">{{ stats.books }}</div>
          <div class="stat-label">书籍总数</div>
        </div>
      </div>
      <!-- 代码 -->
      <div class="stat-card">
        <div class="stat-card-title">代码</div>
        <div class="stat-item">
          <div class="stat-value">{{ stats.code }}</div>
          <div class="stat-label">代码仓库</div>
        </div>
      </div>
      <!-- 书签 -->
      <div class="stat-card">
        <div class="stat-card-title">书签</div>
        <div class="stat-item">
          <div class="stat-value">{{ stats.bookmarks }}</div>
          <div class="stat-label">书签总数</div>
        </div>
      </div>
      <!-- 游戏 -->
      <div class="stat-card">
        <div class="stat-card-title">游戏</div>
        <div class="stat-item">
          <div class="stat-value">{{ stats.games }}</div>
          <div class="stat-label">游戏总数</div>
        </div>
      </div>
      <!-- 博客详情 -->
      <div class="stat-card">
        <div class="stat-card-title">博客详情</div>
        <div class="blog-grid">
          <div class="blog-stat-item">
            <div class="stat-value">{{ stats.blog?.published || 0 }}</div>
            <div class="stat-label">已发布</div>
          </div>
          <div class="blog-stat-item">
            <div class="stat-value">{{ stats.blog?.draft || 0 }}</div>
            <div class="stat-label">草稿</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 动漫卡片独占一行 -->
    <div class="stat-card anime-card">
      <div class="stat-card-title">动漫详情</div>
      <div class="anime-grid">
        <div class="anime-stat-item">
          <div class="stat-value">{{ stats.anime.total }}</div>
          <div class="stat-label">总数</div>
        </div>
        <div class="anime-stat-item">
          <div class="stat-value">{{ stats.anime.want_to_watch }}</div>
          <div class="stat-label">想看</div>
        </div>
        <div class="anime-stat-item">
          <div class="stat-value">{{ stats.anime.watching }}</div>
          <div class="stat-label">在看</div>
        </div>
        <div class="anime-stat-item">
          <div class="stat-value">{{ stats.anime.watched }}</div>
          <div class="stat-label">看过</div>
        </div>
      </div>
    </div>

    <!-- 日程表 -->
    <div class="stat-card calendar-card">
      <div class="stat-card-title">日程表</div>
      <div class="calendar-container">
        <div class="calendar-header">
          <button class="icon-btn" @click="prevMonth">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
            </svg>
          </button>
          <span class="calendar-title">{{ currentYear }}年{{ currentMonth + 1 }}月</span>
          <button class="icon-btn" @click="nextMonth">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>
          </button>
          <button class="btn-outline" @click="goToToday">今天</button>
        </div>
        <div class="calendar-weekdays">
          <div class="weekday" v-for="day in weekdays" :key="day">{{ day }}</div>
        </div>
        <div class="calendar-days">
          <div 
            v-for="(day, index) in calendarDays" 
            :key="index"
            class="calendar-day"
            :class="{
              'other-month': day.otherMonth,
              'today': day.isToday,
              'selected': day.date === selectedDate,
              'has-todos': day.hasTodos
            }"
            @click="selectDate(day)"
          >
            <span class="day-number">{{ day.day }}</span>
            <div v-if="day.hasTodos" class="todo-dot"></div>
          </div>
        </div>
      </div>

      <!-- Todo List -->
      <div class="todo-section">
        <div class="todo-header">
          <h4>{{ formatSelectedDate }}</h4>
          <button class="btn-primary" @click="addTodo" :disabled="isGuest">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
          </button>
        </div>
        <div class="todo-list" v-if="todos.length > 0">
          <div 
            v-for="(todo, index) in todos" 
            :key="`todo-${index}-${todo.id}`" 
            class="todo-item"
            :class="{ completed: !!todo.completed, confirmed: !!todo.confirmed, editing: !!todo.editing }"
          >
            <label class="checkbox-wrapper" v-if="!isGuest">
              <input 
                type="checkbox" 
                :checked="!!todo.completed"
                @change="(e) => { todo.completed = e.target.checked ? 1 : 0; updateTodo(todo) }"
              />
              <span class="checkbox-custom"></span>
            </label>
            <textarea 
              :value="todo.text || ''"
              @input="(e) => todo.text = e.target.value"
              placeholder="输入待办内容"
              :disabled="!!todo.confirmed && !todo.editing"
              @blur="handleBlur(todo)"
              class="todo-input"
              rows="1"
            />
            <button
              v-if="!todo.confirmed && !todo.editing"
              class="btn-icon btn-success"
              @click="confirmTodo(todo)"
              :disabled="isGuest"
            >
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </button>
            <button
              v-if="todo.confirmed && !todo.editing"
              class="btn-icon btn-primary"
              @click="editTodo(todo)"
              :disabled="isGuest"
            >
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
              </svg>
            </button>
            <button
              v-if="todo.editing"
              class="btn-icon btn-success"
              @click="saveEdit(todo)"
              :disabled="isGuest"
            >
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </button>
            <button class="btn-icon btn-danger" @click="deleteTodo(todo.id)" :disabled="isGuest">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </button>
          </div>
        </div>
        <div v-else class="empty-todos">
          暂无待办事项
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'

const { isGuest } = usePermission()

const stats = ref({
  documents: 0,
  music: 0,
  books: 0,
  games: 0,
  code: 0,
  bookmarks: 0,
  blog: {
    total: 0,
    published: 0,
    draft: 0
  },
  anime: {
    total: 0,
    favorite: 0,
    watching: 0,
    watched: 0
  }
})

// 日程表相关
const weekdays = ['日', '一', '二', '三', '四', '五', '六']
const currentYear = ref(new Date().getFullYear())
const currentMonth = ref(new Date().getMonth())
const selectedDate = ref(formatDate(new Date()))
const todos = ref([])
const todosByDate = ref({})

// 格式化日期为 YYYY-MM-DD
function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 获取当月日历数据
const calendarDays = computed(() => {
  const days = []
  const firstDay = new Date(currentYear.value, currentMonth.value, 1)
  const lastDay = new Date(currentYear.value, currentMonth.value + 1, 0)
  const startDayOfWeek = firstDay.getDay()
  const totalDays = lastDay.getDate()

  const prevMonthLastDay = new Date(currentYear.value, currentMonth.value, 0).getDate()
  
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i
    const date = formatDate(new Date(currentYear.value, currentMonth.value - 1, day))
    days.push({
      day,
      date,
      otherMonth: true,
      isToday: false,
      hasTodos: todosByDate.value[date]?.length > 0
    })
  }

  const today = formatDate(new Date())
  for (let i = 1; i <= totalDays; i++) {
    const date = formatDate(new Date(currentYear.value, currentMonth.value, i))
    days.push({
      day: i,
      date,
      otherMonth: false,
      isToday: date === today,
      hasTodos: todosByDate.value[date]?.length > 0
    })
  }

  const remainingDays = 42 - days.length
  for (let i = 1; i <= remainingDays; i++) {
    const date = formatDate(new Date(currentYear.value, currentMonth.value + 1, i))
    days.push({
      day: i,
      date,
      otherMonth: true,
      isToday: false,
      hasTodos: todosByDate.value[date]?.length > 0
    })
  }

  return days
})

const formatSelectedDate = computed(() => {
  if (!selectedDate.value) return ''
  const [year, month, day] = selectedDate.value.split('-')
  const shortYear = year.slice(-2)
  return `${shortYear}.${parseInt(month)}.${parseInt(day)} 待办`
})

function prevMonth() {
  if (currentMonth.value === 0) {
    currentMonth.value = 11
    currentYear.value--
  } else {
    currentMonth.value--
  }
  // 切换月份后重新加载待办数据
  loadMonthTodos()
}

function nextMonth() {
  if (currentMonth.value === 11) {
    currentMonth.value = 0
    currentYear.value++
  } else {
    currentMonth.value++
  }
  // 切换月份后重新加载待办数据
  loadMonthTodos()
}

function goToToday() {
  const today = new Date()
  currentYear.value = today.getFullYear()
  currentMonth.value = today.getMonth()
  selectedDate.value = formatDate(today)
  loadTodos(selectedDate.value)
}

function selectDate(day) {
  selectedDate.value = day.date
  loadTodos(day.date)
}

async function loadTodos(date) {
  try {
    const response = await api.todos.list(date)
    todos.value = (response.data.data || []).map(t => ({
      ...t,
      text: t.text || '',
      completed: t.completed || 0,
      confirmed: t.confirmed || 0,
      editing: false
    }))
  } catch (error) {
    console.error('加载待办事项失败:', error)
    todos.value = []
  }
}

async function loadMonthTodos() {
  try {
    // 计算日历显示范围（包括前后月份的灰色日期）
    const firstDay = new Date(currentYear.value, currentMonth.value, 1)
    const startDayOfWeek = firstDay.getDay()
    
    // 日历显示的起始日期（可能包含上个月的日期）
    const displayStartDate = new Date(currentYear.value, currentMonth.value, 1 - startDayOfWeek)
    // 日历显示的结束日期（42个格子，即6周）
    const displayEndDate = new Date(displayStartDate)
    displayEndDate.setDate(displayStartDate.getDate() + 41)
    
    const startDate = formatDate(displayStartDate)
    const endDate = formatDate(displayEndDate)
    
    const response = await api.todos.listMonth(startDate, endDate)
    const todosMap = {}
    ;(response.data.data || []).forEach(todo => {
      if (!todosMap[todo.date]) {
        todosMap[todo.date] = []
      }
      todosMap[todo.date].push(todo)
    })
    todosByDate.value = todosMap
  } catch (error) {
    console.error('加载月度待办事项失败:', error)
  }
}

const creatingTodos = new Set()

function addTodo() {
  if (isGuest.value) return
  
  const newTodo = {
    id: `new-${Date.now()}`,
    text: '',
    completed: 0,
    confirmed: 0,
    date: selectedDate.value,
    isNew: true,
    editing: false
  }
  todos.value.push(newTodo)

  nextTick(() => {
    const inputs = document.querySelectorAll('.todo-input')
    if (inputs.length > 0) {
      const lastInput = inputs[inputs.length - 1]
      lastInput.focus()
    }
  })
}

async function confirmTodo(todo) {
  if (!(todo.text || '').trim()) {
    return
  }
  
  if (creatingTodos.has(todo.id)) {
    while (creatingTodos.has(todo.id)) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  
  todo.confirmed = 1
  await updateTodo(todo)
}

function editTodo(todo) {
  todo.editing = true
  todo._originalText = todo.text
  
  nextTick(() => {
    const todoItems = document.querySelectorAll('.todo-item')
    const todoIndex = todos.value.findIndex(t => t.id === todo.id)
    if (todoIndex !== -1 && todoItems[todoIndex]) {
      const input = todoItems[todoIndex].querySelector('.todo-input')
      if (input) {
        input.focus()
      }
    }
  })
}

async function saveEdit(todo) {
  todo.editing = false
  delete todo._originalText
  await updateTodo(todo)
}

async function handleBlur(todo) {
  if (todo.confirmed && todo.editing) {
    return
  }
  await updateTodo(todo)
}

async function updateTodo(todo) {
  const text = (todo.text || '').trim()
  
  if (!text) {
    if (todo.isNew) {
      creatingTodos.delete(todo.id)
      todos.value = todos.value.filter(t => t.id !== todo.id)
      return
    }
    return
  }
  
  if (creatingTodos.has(todo.id)) {
    return
  }
  
  try {
    if (todo.isNew) {
      creatingTodos.add(todo.id)
      
      const response = await api.todos.create({
        text: text,
        date: todo.date,
        completed: todo.completed || 0,
        confirmed: todo.confirmed || 0
      })
      const oldId = todo.id
      todo.id = String(response.data.id)
      todo.isNew = false
      
      const index = todos.value.findIndex(t => t.id === oldId)
      if (index !== -1) {
        todos.value[index] = todo
      }
      
      creatingTodos.delete(oldId)
    } else {
      await api.todos.update(todo.id, {
        text: text,
        completed: todo.completed || 0,
        confirmed: todo.confirmed || 0
      })
    }
    loadMonthTodos()
  } catch (error) {
    console.error('保存待办事项失败:', error)
    creatingTodos.delete(todo.id)
  }
}

async function deleteTodo(id) {
  try {
    const todo = todos.value.find(t => t.id === id)
    if (todo && !todo.isNew) {
      await api.todos.delete(id)
    }
    todos.value = todos.value.filter(t => t.id !== id)
    loadMonthTodos()
  } catch (error) {
    console.error('删除待办事项失败:', error)
  }
}

async function loadStats() {
  try {
    const response = await api.stats.get()
    const data = response.data.data
    
    stats.value.documents = data.documents || 0
    stats.value.music = data.music || 0
    stats.value.books = data.books || 0
    stats.value.games = data.games || 0
    stats.value.code = data.code || 0
    stats.value.bookmarks = data.bookmarks || 0
    stats.value.blog = data.blog || { total: 0, published: 0, draft: 0 }
    stats.value.anime = data.anime || { total: 0, want_to_watch: 0, watching: 0, watched: 0 }
  } catch (error) {
    console.error('Failed to load stats:', error)
  }
}

onMounted(() => {
  loadStats()
  loadMonthTodos()
  loadTodos(selectedDate.value)
})
</script>

<style scoped>
.mobile-dashboard {
  padding: 0;
}

/* 统计卡片网格布局：每行2个 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  width: 100%;
}

/* 原生卡片样式替代 t-card */
.stat-card {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 0.3s ease;
  animation: fadeInUp 0.6s ease-out backwards;
  overflow: hidden;
}

.stat-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  transform: translateY(-2px);
}

.stat-card-title {
  padding: 12px 16px 0;
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.stat-card .stat-item {
  padding: 12px 16px 16px;
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.stat-item {
  text-align: center;
}

.stat-value {
  font-size: 22px;
  font-weight: bold;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 4px;
  line-height: 1.2;
}

.stat-label {
  font-size: 12px;
  color: #666;
}

/* 动漫卡片独占一行 */
.anime-card {
  margin-top: 12px;
}

.anime-card .anime-grid {
  padding: 12px 16px 16px;
}

/* 博客卡片：2列网格布局 */
.blog-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  padding: 12px 16px 16px;
  justify-items: center;
}

.blog-stat-item {
  width: 100%;
  text-align: center;
}

.blog-stat-item .stat-label {
  font-size: 12px;
  white-space: nowrap;
}

/* 动漫卡片：横向4列布局 */
.anime-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  justify-items: center;
}

.anime-stat-item {
  padding: 4px 0;
  width: 100%;
  text-align: center;
}

.anime-stat-item .stat-value {
  font-size: 18px;
}

.anime-stat-item .stat-label {
  font-size: 11px;
}

/* 日程表卡片 */
.calendar-card {
  margin-top: 24px;
}

.calendar-card .calendar-container {
  padding: 12px 16px 16px;
}

/* 日程表样式 */
.calendar-container {
  width: 100%;
}

.calendar-header {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  gap: 4px;
  flex-wrap: wrap;
}

.calendar-title {
  font-size: 16px;
  font-weight: 600;
  min-width: 100px;
  text-align: center;
}

/* 原生按钮样式 */
.icon-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: #666;
  cursor: pointer;
  transition: all 0.2s;
}

.icon-btn:hover {
  background: #f5f5f5;
}

.btn-outline {
  padding: 6px 12px;
  background: transparent;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  transition: all 0.2s;
  margin-left: 8px;
}

.btn-outline:hover {
  border-color: #667eea;
  color: #667eea;
}

.btn-primary {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0052d9;
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary:hover:not(:disabled) {
  background: #0043b3;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  padding: 0;
}

.btn-success {
  color: #2ba471;
}

.btn-success:hover:not(:disabled) {
  background: rgba(43, 164, 113, 0.1);
}

.btn-primary.btn-icon {
  color: #0052d9;
}

.btn-primary.btn-icon:hover:not(:disabled) {
  background: rgba(0, 82, 217, 0.1);
}

.btn-danger {
  color: #e34d59;
}

.btn-danger:hover:not(:disabled) {
  background: rgba(227, 77, 89, 0.1);
}

.btn-icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.calendar-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
  padding: 0 2px;
}

.weekday {
  text-align: center;
  padding: 6px 0;
  font-weight: 600;
  color: #666;
  font-size: 12px;
}

.calendar-days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  padding: 0 2px;
}

.calendar-day {
  height: 50px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s ease;
  padding: 2px;
  width: 100%;
  min-width: 0;
}

.calendar-day:hover {
  background: #f5f5f5;
}

.calendar-day.other-month {
  color: #ccc;
}

.calendar-day.today {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.calendar-day.selected:not(.today) {
  background: #e8e4f8;
  color: #667eea;
  box-shadow: 0 3px 10px rgba(102, 126, 234, 0.25);
}

.calendar-day .day-number {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}

.todo-dot {
  position: absolute;
  top: auto;
  bottom: 4px;
  right: 50%;
  transform: translateX(50%);
  width: 16px;
  height: 2px;
  border-radius: 1px;
  background: #667eea;
}

.calendar-day.today .todo-dot {
  background: white;
}

/* Todo List 样式 */
.todo-section {
  display: block;
  width: 100%;
  margin-top: 24px;
  padding: 16px;
  border-top: 1px solid #eee;
  clear: both;
}

.todo-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.todo-header h4 {
  margin: 0;
  font-size: 16px;
  color: #333;
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.todo-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  background: #f9f9f9;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.todo-item:hover {
  background: #f0f0f0;
}

.todo-item.completed .todo-input {
  text-decoration: line-through;
  color: #999;
}

.todo-item.confirmed {
  background: #f8f9fa;
}

.todo-item.editing {
  background: #fff8e6;
}

/* 原生复选框样式 */
.checkbox-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}

.checkbox-wrapper input[type="checkbox"] {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.checkbox-custom {
  width: 18px;
  height: 18px;
  border: 2px solid #ccc;
  border-radius: 4px;
  transition: all 0.2s;
  position: relative;
}

.checkbox-wrapper input[type="checkbox"]:checked + .checkbox-custom {
  background: #0052d9;
  border-color: #0052d9;
}

.checkbox-wrapper input[type="checkbox"]:checked + .checkbox-custom::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 1px;
  width: 4px;
  height: 9px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.todo-input {
  flex: 1;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 14px;
  font-family: inherit;
  font-weight: inherit;
  outline: none;
  width: 100%;
  word-wrap: break-word;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  overflow-y: auto;
  resize: none;
  min-height: 20px;
  max-height: 80px;
  line-height: 1.5;
}

.todo-input:disabled {
  background: transparent;
  cursor: default;
  color: #333;
}

.todo-input::placeholder {
  color: #bbb;
}

.todo-input::-webkit-scrollbar {
  width: 4px;
}

.todo-input::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 2px;
}

.todo-input::-webkit-scrollbar-thumb {
  background: rgba(102, 126, 234, 0.3);
  border-radius: 2px;
}

.todo-input::-webkit-scrollbar-thumb:hover {
  background: rgba(102, 126, 234, 0.5);
}

.empty-todos {
  text-align: center;
  padding: 40px 20px;
  color: #999;
  font-size: 14px;
}
</style>