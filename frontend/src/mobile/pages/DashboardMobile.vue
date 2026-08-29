<template>
  <div class="dashboard mobile-dashboard">
    <SystemStatusOverview />
    <section class="mobile-resource-overview" aria-labelledby="mobile-resource-title">
      <div class="mobile-resource-heading">
        <div><span>内容资产</span><h2 id="mobile-resource-title">资源总览</h2></div>
        <small>按类型统计</small>
      </div>
      <div class="stats-grid">
        <article v-for="item in resourceStats" :key="item.key" class="stat-card resource-stat-card">
          <span class="resource-stat-icon" :class="`resource-stat-icon--${item.tone}`">
            <NativeIcon :name="item.icon" size="18" weight="duotone" />
          </span>
          <span class="stat-card-title">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
          <small class="stat-label">{{ item.unit }}</small>
        </article>
      </div>

      <article class="stat-card anime-card">
        <div class="anime-card-heading">
          <span class="resource-stat-icon resource-stat-icon--cyan"><NativeIcon name="video" size="18" weight="duotone" /></span>
          <div><strong>动漫进度</strong><small>收藏状态分布</small></div>
        </div>
        <div class="anime-grid">
          <div v-for="item in animeStats" :key="item.label" class="anime-stat-item">
            <div class="stat-value">{{ item.value }}</div>
            <div class="stat-label">{{ item.label }}</div>
          </div>
        </div>
      </article>
    </section>

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
import { NativeIcon } from '@/components/native'
import SystemStatusOverview from '@/components/business/SystemStatusOverview.vue'

const { isGuest } = usePermission()

const stats = ref({
  documents: 0,
  music: 0,
  books: 0,
  games: 0,
  code: 0,
  bookmarks: 0,
  blog: {
    total: 0
  },
  anime: {
    total: 0,
    favorite: 0,
    watching: 0,
    watched: 0
  }
})

const resourceStats = computed(() => [
  { key: 'documents', label: '文档', value: stats.value.documents, unit: '份内容', icon: 'file-text', tone: 'indigo' },
  { key: 'blog', label: '个人笔记', value: stats.value.blog?.total || 0, unit: '篇笔记', icon: 'pencil', tone: 'violet' },
  { key: 'music', label: '音频', value: stats.value.music, unit: '首音频', icon: 'music', tone: 'cyan' },
  { key: 'books', label: '电子书', value: stats.value.books, unit: '本藏书', icon: 'book', tone: 'amber' },
  { key: 'code', label: '代码知识库', value: stats.value.code, unit: '个仓库', icon: 'code', tone: 'slate' },
  { key: 'bookmarks', label: '书签', value: stats.value.bookmarks, unit: '个链接', icon: 'bookmark', tone: 'rose' },
  { key: 'games', label: '游戏', value: stats.value.games, unit: '款游戏', icon: 'gamepad', tone: 'emerald' }
])

const animeStats = computed(() => [
  { label: '总数', value: stats.value.anime.total },
  { label: '想看', value: stats.value.anime.want_to_watch || 0 },
  { label: '在看', value: stats.value.anime.watching },
  { label: '看过', value: stats.value.anime.watched }
])

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
    stats.value.blog = data.blog || { total: 0 }
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

.mobile-resource-overview {
  margin-bottom: 24px;
  padding: 16px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
}

.mobile-resource-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.mobile-resource-heading span {
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.mobile-resource-heading h2 { margin: 3px 0 0; color: var(--color-text-primary); font-size: 18px; }
.mobile-resource-heading > small { color: var(--color-text-muted); font-size: 11px; }

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  width: 100%;
}

.stat-card {
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-page);
  overflow: hidden;
}

.resource-stat-card {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 2px 9px;
  padding: 12px;
}

.stat-card-title {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-stat-icon {
  display: grid;
  width: 34px;
  height: 34px;
  grid-row: 1 / span 2;
  place-items: center;
  color: var(--color-primary);
  border-radius: var(--radius-md);
  background: var(--color-primary-surface);
}

.resource-stat-icon--cyan { color: #0f766e; background: #e6f7f5; }
.resource-stat-icon--amber { color: #a16207; background: #fef3c7; }
.resource-stat-icon--emerald { color: #047857; background: #dff7ec; }
.resource-stat-icon--rose { color: #be4166; background: #fff0f4; }
.resource-stat-icon--slate { color: #475569; background: #e9edf3; }
.resource-stat-icon--violet { color: #7357b5; background: #f2edff; }

.stat-value {
  color: var(--color-text-primary);
  font-size: 21px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
}

.stat-label {
  grid-column: 1 / -1;
  margin-top: 7px;
  color: var(--color-text-muted);
  font-size: 10px;
}

.anime-card {
  margin-top: 8px;
  padding: 12px;
}

.anime-card-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-bottom: 11px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.anime-card-heading > div { display: grid; gap: 2px; }
.anime-card-heading strong { color: var(--color-text-primary); font-size: 12px; }
.anime-card-heading small { color: var(--color-text-muted); font-size: 10px; }

/* 动漫卡片：横向4列布局 */
.anime-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  padding-top: 11px;
  justify-items: center;
}

.anime-stat-item {
  padding: 3px 0;
  width: 100%;
  text-align: center;
}

.anime-stat-item + .anime-stat-item { border-left: 1px solid var(--color-border-subtle); }

.anime-stat-item .stat-value {
  font-size: 18px;
}

.anime-stat-item .stat-label {
  display: block;
  margin-top: 4px;
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
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.icon-btn:hover {
  background: var(--color-surface-subtle);
}

.btn-outline {
  padding: 6px 12px;
  background: transparent;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  margin-left: 8px;
}

.btn-outline:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.btn-primary {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
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
  color: var(--color-primary);
}

.btn-primary.btn-icon:hover:not(:disabled) {
  background: rgba(0, 82, 217, 0.1);
}

.btn-danger {
  color: var(--color-danger);
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
  color: var(--color-text-secondary);
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
  background: var(--color-surface-subtle);
}

.calendar-day.other-month {
  color: #ccc;
}

.calendar-day.today {
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-active) 100%);
  color: white;
  box-shadow: 0 4px 12px var(--color-primary-alpha-40);
}

.calendar-day.selected:not(.today) {
  background: #e8e4f8;
  color: var(--color-primary);
  box-shadow: 0 3px 10px var(--color-primary-alpha-25);
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
  background: var(--color-primary);
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
  color: var(--color-text-primary);
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
  color: var(--color-text-muted);
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
  background: var(--color-primary);
  border-color: var(--color-primary);
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
  color: var(--color-text-primary);
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
  background: var(--color-primary-alpha-30);
  border-radius: 2px;
}

.todo-input::-webkit-scrollbar-thumb:hover {
  background: var(--color-primary-alpha-50);
}

.empty-todos {
  text-align: center;
  padding: 40px 20px;
  color: var(--color-text-muted);
  font-size: 14px;
}
</style>
