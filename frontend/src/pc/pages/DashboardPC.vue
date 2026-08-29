<template>
  <div class="dashboard">
    <SystemStatusOverview />
    <section class="resource-overview" aria-labelledby="resource-overview-title">
      <div class="resource-heading">
        <div>
          <p>内容资产</p>
          <h2 id="resource-overview-title">资源总览</h2>
        </div>
        <span>按资源类型统计</span>
      </div>
      <div class="resource-stat-grid">
        <article v-for="item in resourceStats" :key="item.key" class="resource-stat-card">
          <span class="resource-stat-icon" :class="`resource-stat-icon--${item.tone}`">
            <NativeIcon :name="item.icon" size="19" weight="duotone" />
          </span>
          <span class="resource-stat-label">{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.unit }}</small>
        </article>
      </div>
      <article class="anime-summary-card">
        <div class="anime-summary-title">
          <span class="resource-stat-icon resource-stat-icon--cyan">
            <NativeIcon name="video" size="19" weight="duotone" />
          </span>
          <div><strong>动漫进度</strong><small>收藏状态分布</small></div>
        </div>
        <div class="anime-summary-grid">
          <div v-for="item in animeStats" :key="item.label">
            <strong>{{ item.value }}</strong>
            <span>{{ item.label }}</span>
          </div>
        </div>
      </article>
    </section>

    <!-- 日程表 -->
    <NativeCard title="日程表" style="margin-top: 24px;">
      <div class="calendar-container">
        <div class="calendar-header">
          <NativeButton variant="text" @click="prevMonth">
            <template #icon><NativeIcon name="chevron-left" /></template>
          </NativeButton>
          <span class="calendar-title">{{ currentYear }}年{{ currentMonth + 1 }}月</span>
          <NativeButton variant="text" @click="nextMonth">
            <template #icon><NativeIcon name="chevron-right" /></template>
          </NativeButton>
          <NativeButton variant="outline" size="small" style="margin-left: 16px;" @click="goToToday">今天</NativeButton>
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
              'has-todos': day.hasTodos,
              'festival': day.isFestival
            }"
            @click="selectDate(day)"
          >
            <span class="day-number">{{ day.day }}</span>
            <span class="lunar-text" v-if="day.lunar">{{ day.lunar }}</span>
            <div v-if="day.hasTodos" class="todo-dot"></div>
          </div>
        </div>
      </div>

      <!-- Todo List -->
      <div class="todo-section">
        <div class="todo-header">
          <h4>{{ formatSelectedDate }} 的待办事项</h4>
          <NativeButton theme="primary" size="small" @click="addTodo" :disabled="isGuest">
            <template #icon><NativeIcon name="plus" /></template>
            添加待办
          </NativeButton>
        </div>
        <div class="todo-list" v-if="todos.length > 0">
          <div 
            v-for="(todo, index) in todos" 
            :key="`todo-${index}-${todo.id}`" 
            class="todo-item"
            :class="{ completed: !!todo.completed, confirmed: !!todo.confirmed, editing: !!todo.editing }"
          >
            <NativeCheckbox 
              v-if="!isGuest"
              :model-value="!!todo.completed"
              @change="(val) => { todo.completed = val ? 1 : 0; updateTodo(todo) }"
            />
            <input 
              type="text"
              :value="todo.text || ''"
              @input="(e) => todo.text = e.target.value"
              placeholder="输入待办内容"
              :disabled="!!todo.confirmed && !todo.editing"
              @blur="handleBlur(todo)"
              @keyup.enter="(e) => handleTodoEnter(todo, e)"
              class="todo-input"
            />
            <NativeButton
              v-if="!todo.confirmed && !todo.editing"
              variant="outline"
              size="small"
              theme="success"
              @click="confirmTodo(todo)"
              :disabled="isGuest"
            >
              确认
            </NativeButton>
            <NativeButton
              v-if="todo.confirmed && !todo.editing"
              variant="outline"
              size="small"
              theme="primary"
              @click="editTodo(todo)"
              :disabled="isGuest"
            >
              编辑
            </NativeButton>
            <NativeButton
              v-if="todo.editing"
              variant="outline"
              size="small"
              theme="success"
              @click="saveEdit(todo)"
              :disabled="isGuest"
            >
              保存
            </NativeButton>
            <NativeButton variant="text" theme="danger" @click="deleteTodo(todo.id)" :disabled="isGuest">
              <template #icon><NativeIcon name="trash" /></template>
            </NativeButton>
          </div>
        </div>
        <div v-else class="empty-todos">
          暂无待办事项
        </div>
      </div>
    </NativeCard>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import api from '@/api'
import { Solar } from 'lunar-javascript'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeInput, NativeCard, NativeDialog, NativeCheckbox, NativeIcon } from '@/components/native'
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
const todosByDate = ref({}) // 缓存每个日期的待办事项

// 格式化日期为 YYYY-MM-DD
function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 获取农历信息
function getLunarInfo(year, month, day) {
  try {
    const solar = Solar.fromYmd(year, month, day)
    const lunar = solar.getLunar()
    
    // 获取节日（优先显示节日）
    const festivals = lunar.getFestivals()
    const solarFestivals = solar.getFestivals()
    const allFestivals = [...festivals, ...solarFestivals]
    
    // 获取节气
    const jieQi = lunar.getJieQi()
    
    // 获取农历日
    const lunarDay = lunar.getDayInChinese()
    
    // 如果有节日，优先显示节日
    if (allFestivals.length > 0) {
      return { text: allFestivals[0], isFestival: true }
    }
    
    // 如果有节气，显示节气
    if (jieQi) {
      return { text: jieQi, isFestival: true }
    }
    
    // 初一显示月份
    if (lunarDay === '初一') {
      return { text: lunar.getMonthInChinese() + '月', isFestival: false }
    }
    
    // 其他显示农历日
    return { text: lunarDay, isFestival: false }
  } catch (e) {
    return { text: '', isFestival: false }
  }
}

// 获取当月日历数据
const calendarDays = computed(() => {
  const days = []
  const firstDay = new Date(currentYear.value, currentMonth.value, 1)
  const lastDay = new Date(currentYear.value, currentMonth.value + 1, 0)
  const startDayOfWeek = firstDay.getDay()
  const totalDays = lastDay.getDate()

  // 上个月的天数
  const prevMonthLastDay = new Date(currentYear.value, currentMonth.value, 0).getDate()
  // 上个月的年份和月份（处理跨年）
  const prevMonthYear = currentMonth.value === 0 ? currentYear.value - 1 : currentYear.value
  const prevMonthNum = currentMonth.value === 0 ? 12 : currentMonth.value
  
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i
    const date = formatDate(new Date(currentYear.value, currentMonth.value - 1, day))
    const lunarInfo = getLunarInfo(prevMonthYear, prevMonthNum, day)
    days.push({
      day,
      date,
      otherMonth: true,
      isToday: false,
      hasTodos: todosByDate.value[date]?.length > 0,
      lunar: lunarInfo.text,
      isFestival: lunarInfo.isFestival
    })
  }

  // 当月的天数
  const today = formatDate(new Date())
  const currentMonthNum = currentMonth.value + 1 // lunar-javascript 使用 1-12
  for (let i = 1; i <= totalDays; i++) {
    const date = formatDate(new Date(currentYear.value, currentMonth.value, i))
    const lunarInfo = getLunarInfo(currentYear.value, currentMonthNum, i)
    days.push({
      day: i,
      date,
      otherMonth: false,
      isToday: date === today,
      hasTodos: todosByDate.value[date]?.length > 0,
      lunar: lunarInfo.text,
      isFestival: lunarInfo.isFestival
    })
  }

  // 下个月的天数（补齐6行）
  const remainingDays = 42 - days.length
  // 下个月的年份和月份（处理跨年）
  const nextMonthYear = currentMonth.value === 11 ? currentYear.value + 1 : currentYear.value
  const nextMonthNum = currentMonth.value === 11 ? 1 : currentMonth.value + 2
  
  for (let i = 1; i <= remainingDays; i++) {
    const date = formatDate(new Date(currentYear.value, currentMonth.value + 1, i))
    const lunarInfo = getLunarInfo(nextMonthYear, nextMonthNum, i)
    days.push({
      day: i,
      date,
      otherMonth: true,
      isToday: false,
      hasTodos: todosByDate.value[date]?.length > 0,
      lunar: lunarInfo.text,
      isFestival: lunarInfo.isFestival
    })
  }

  return days
})

// 格式化选中日期显示
const formatSelectedDate = computed(() => {
  if (!selectedDate.value) return ''
  const [year, month, day] = selectedDate.value.split('-')
  return `${year}年${parseInt(month)}月${parseInt(day)}日`
})

// 上个月
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

// 下个月
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

// 回到今天
function goToToday() {
  const today = new Date()
  currentYear.value = today.getFullYear()
  currentMonth.value = today.getMonth()
  selectedDate.value = formatDate(today)
  loadTodos(selectedDate.value)
}

// 选择日期
function selectDate(day) {
  selectedDate.value = day.date
  loadTodos(day.date)
}

// 加载待办事项
async function loadTodos(date) {
  try {
    const response = await api.todos.list(date)
    // 确保数据格式正确
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

// 加载月份所有待办事项（用于显示小圆点）
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
    // 将数据转换为日期索引
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

// 正在创建中的待办 ID 集合（防止重复创建）
const creatingTodos = new Set()

// 添加待办
function addTodo() {
  if (isGuest.value) return
  
  const newTodo = {
    id: `new-${Date.now()}`, // 使用字符串 ID
    text: '',
    completed: 0,
    confirmed: 0,
    date: selectedDate.value,
    isNew: true,
    editing: false // 不自动进入编辑状态，直接显示确认按钮
  }
  todos.value.push(newTodo)

  // 自动聚焦到新添加的输入框
  nextTick(() => {
    const inputs = document.querySelectorAll('.todo-input')
    if (inputs.length > 0) {
      const lastInput = inputs[inputs.length - 1]
      lastInput.focus()
    }
  })
}

// 确认待办（锁定内容，不可编辑）
async function confirmTodo(todo) {
  // 如果内容为空，不确认
  if (!(todo.text || '').trim()) {
    return
  }
  
  // 如果正在创建中，等待创建完成
  if (creatingTodos.has(todo.id)) {
    // 等待创建完成（轮询检查）
    while (creatingTodos.has(todo.id)) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  
  // 标记为已确认
  todo.confirmed = 1
  await updateTodo(todo)
}

// 编辑已确认的待办
function editTodo(todo) {
  todo.editing = true
  todo._originalText = todo.text // 保存原始内容，用于取消时恢复
  
  // 等待DOM更新后，聚焦并选中文本，光标移到末尾
  nextTick(() => {
    const todoItems = document.querySelectorAll('.todo-item')
    const todoIndex = todos.value.findIndex(t => t.id === todo.id)
    if (todoIndex !== -1 && todoItems[todoIndex]) {
      const input = todoItems[todoIndex].querySelector('.todo-input')
      if (input) {
        input.focus()
        // 选中文本并将光标移到末尾
        const textLength = (todo.text || '').length
        input.setSelectionRange(textLength, textLength)
      }
    }
  })
}

// 保存编辑
async function saveEdit(todo) {
  todo.editing = false
  delete todo._originalText
  await updateTodo(todo)
}

// 处理失焦
async function handleBlur(todo) {
  // 如果正在编辑已确认的待办，不自动保存，等点击保存按钮
  if (todo.confirmed && todo.editing) {
    return
  }
  await updateTodo(todo)
}

// 处理回车键：编辑状态保存，新增状态确认，无内容则删除
async function handleTodoEnter(todo, e) {
  const text = (todo.text || '').trim()
  
  // 如果正在编辑已确认的待办，保存编辑
  if (todo.confirmed && todo.editing) {
    await saveEdit(todo)
    return
  }
  
  if (text) {
    // 有内容：执行确认操作
    await confirmTodo(todo)
  } else {
    // 无内容：删除该待办
    if (todo.isNew) {
      // 新建的空待办，直接从列表移除
      todos.value = todos.value.filter(t => t.id !== todo.id)
    } else {
      // 已存在的空待办，也删除
      await deleteTodo(todo.id)
    }
  }
}

// 更新待办
async function updateTodo(todo) {
  const text = (todo.text || '').trim()
  
  // 如果内容为空
  if (!text) {
    // 新建的空待办，直接删除
    if (todo.isNew) {
      creatingTodos.delete(todo.id) // 清理创建标记
      todos.value = todos.value.filter(t => t.id !== todo.id)
      return
    }
    // 已存在的待办，不保存空内容
    return
  }
  
  // 如果正在创建中，不重复创建
  if (creatingTodos.has(todo.id)) {
    return
  }
  
  try {
    if (todo.isNew) {
      // 标记为正在创建
      creatingTodos.add(todo.id)
      
      // 新建
      const response = await api.todos.create({
        text: text,
        date: todo.date,
        completed: todo.completed || 0,
        confirmed: todo.confirmed || 0
      })
      // 使用后端返回的真实 ID，转为字符串保持一致
      const oldId = todo.id
      todo.id = String(response.data.id)
      todo.isNew = false
      
      // 更新 todos 数组中的引用（ID 变化了）
      const index = todos.value.findIndex(t => t.id === oldId)
      if (index !== -1) {
        todos.value[index] = todo
      }
      
      // 创建完成，移除标记
      creatingTodos.delete(oldId)
    } else {
      // 更新
      await api.todos.update(todo.id, {
        text: text,
        completed: todo.completed || 0,
        confirmed: todo.confirmed || 0
      })
    }
    // 更新月度缓存
    loadMonthTodos()
  } catch (error) {
    console.error('保存待办事项失败:', error)
    creatingTodos.delete(todo.id) // 出错时清理标记
  }
}

// 删除待办
async function deleteTodo(id) {
  try {
    const todo = todos.value.find(t => t.id === id)
    // 只删除已保存的待办（不是新建的）
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
.dashboard {
  padding: 0;
}

.resource-overview {
  margin-bottom: 24px;
  padding: 22px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
}

.resource-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.resource-heading p {
  margin: 0 0 4px;
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.resource-heading h2 { margin: 0; color: var(--color-text-primary); font-size: 20px; }
.resource-heading > span { color: var(--color-text-muted); font-size: 12px; }

.resource-stat-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
}

.resource-stat-card {
  min-width: 0;
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 2px 10px;
  padding: 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-page);
}

.resource-stat-icon {
  display: grid;
  width: 36px;
  height: 36px;
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

.resource-stat-label {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-stat-card > strong {
  grid-column: 2;
  color: var(--color-text-primary);
  font-size: 25px;
  line-height: 1.05;
  letter-spacing: -0.03em;
}

.resource-stat-card > small {
  grid-column: 1 / -1;
  margin-top: 8px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.anime-summary-card {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 2fr;
  align-items: center;
  gap: 22px;
  margin-top: 10px;
  padding: 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-page);
}

.anime-summary-title { display: flex; align-items: center; gap: 11px; }
.anime-summary-title > div { display: grid; gap: 3px; }
.anime-summary-title strong { color: var(--color-text-primary); font-size: 13px; }
.anime-summary-title small { color: var(--color-text-muted); font-size: 11px; }
.anime-summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); }
.anime-summary-grid > div { display: grid; gap: 3px; padding: 2px 18px; border-left: 1px solid var(--color-border-subtle); }
.anime-summary-grid strong { color: var(--color-text-primary); font-size: 20px; }
.anime-summary-grid span { color: var(--color-text-muted); font-size: 11px; }

@media (max-width: 1320px) {
  .resource-stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}

/* 日程表样式 */
.calendar-container {
  padding: 16px 0;
}

.calendar-header {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  gap: 8px;
}

.calendar-title {
  font-size: 18px;
  font-weight: 600;
  min-width: 120px;
  text-align: center;
}

.calendar-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 8px;
}

.weekday {
  text-align: center;
  padding: 8px;
  font-weight: 600;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.calendar-days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.calendar-day {
  height: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s ease;
  padding: 4px;
}

.calendar-day:hover {
  background: var(--color-surface-subtle);
}

.calendar-day.other-month {
  color: #ccc;
}

.calendar-day.other-month .lunar-text {
  color: #ccc;
}

.calendar-day.today {
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-active) 100%);
  color: white;
}

.calendar-day.today .lunar-text {
  color: rgba(255, 255, 255, 0.9);
}

.calendar-day.selected:not(.today) {
  background: #e8e4f8;
  color: var(--color-primary);
}

.calendar-day.selected:not(.today) .lunar-text {
  color: var(--color-primary);
}

.calendar-day .day-number {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.2;
}

.calendar-day.today .day-number,
.calendar-day.selected .day-number {
  font-weight: bold;
}

.lunar-text {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
  line-height: 1;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.calendar-day.festival .lunar-text {
  color: #e74c3c;
}

.calendar-day.today.festival .lunar-text {
  color: #ffb3b3;
}

.todo-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-primary);
}

.calendar-day.today .todo-dot {
  background: white;
}

/* Todo List 样式 */
.todo-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid #eee;
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
  gap: 12px;
  padding: 12px;
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

.todo-input {
  flex: 1;
  background: transparent;
  border: none;
  padding: 4px 0;
  font-size: 14px;
  line-height: 1.5;
  height: 28px;
  outline: none;
  width: 100%;
}

.todo-input:disabled {
  background: transparent;
  cursor: default;
  color: var(--color-text-primary);
}

.todo-input::placeholder {
  color: #bbb;
}

.empty-todos {
  text-align: center;
  padding: 40px 20px;
  color: var(--color-text-muted);
  font-size: 14px;
}
</style>
