<template>
  <div class="dashboard">
    <!-- 第一行：6个主要统计 -->
    <t-row :gutter="16">
      <t-col :span="4">
        <t-card title="文档" hover-shadow>
          <div class="stat-item">
            <div class="stat-value">{{ stats.documents }}</div>
            <div class="stat-label">文档总数</div>
          </div>
        </t-card>
      </t-col>
      <t-col :span="4">
        <t-card title="博客" hover-shadow>
          <div class="stat-item">
            <div class="stat-value">{{ stats.blog?.total || 0 }}</div>
            <div class="stat-label">文章总数</div>
          </div>
        </t-card>
      </t-col>
      <t-col :span="4">
        <t-card title="音乐" hover-shadow>
          <div class="stat-item">
            <div class="stat-value">{{ stats.music }}</div>
            <div class="stat-label">音乐总数</div>
          </div>
        </t-card>
      </t-col>
      <t-col :span="4">
        <t-card title="书籍" hover-shadow>
          <div class="stat-item">
            <div class="stat-value">{{ stats.books }}</div>
            <div class="stat-label">书籍总数</div>
          </div>
        </t-card>
      </t-col>
      <t-col :span="4">
        <t-card title="代码" hover-shadow>
          <div class="stat-item">
            <div class="stat-value">{{ stats.code }}</div>
            <div class="stat-label">代码仓库</div>
          </div>
        </t-card>
      </t-col>
      <t-col :span="4">
        <t-card title="书签" hover-shadow>
          <div class="stat-item">
            <div class="stat-value">{{ stats.bookmarks }}</div>
            <div class="stat-label">书签总数</div>
          </div>
        </t-card>
      </t-col>
    </t-row>

    <!-- 第二行：游戏、动漫、博客详情 -->
    <t-row :gutter="16" style="margin-top: 16px;">
      <t-col :span="4">
        <t-card title="游戏" hover-shadow>
          <div class="stat-item">
            <div class="stat-value">{{ stats.games }}</div>
            <div class="stat-label">游戏总数</div>
          </div>
        </t-card>
      </t-col>
      <t-col :span="8">
        <t-card title="博客详情" hover-shadow>
          <t-row :gutter="16">
            <t-col :span="6">
              <div class="stat-item">
                <div class="stat-value">{{ stats.blog?.published || 0 }}</div>
                <div class="stat-label">已发布</div>
              </div>
            </t-col>
            <t-col :span="6">
              <div class="stat-item">
                <div class="stat-value">{{ stats.blog?.draft || 0 }}</div>
                <div class="stat-label">草稿</div>
              </div>
            </t-col>
          </t-row>
        </t-card>
      </t-col>
      <t-col :span="12">
        <t-card title="动漫详情" hover-shadow>
          <t-row :gutter="16">
            <t-col :span="3">
              <div class="stat-item">
                <div class="stat-value">{{ stats.anime.total }}</div>
                <div class="stat-label">动漫总数</div>
              </div>
            </t-col>
            <t-col :span="3">
              <div class="stat-item">
                <div class="stat-value">{{ stats.anime.want_to_watch }}</div>
                <div class="stat-label">想看</div>
              </div>
            </t-col>
            <t-col :span="3">
              <div class="stat-item">
                <div class="stat-value">{{ stats.anime.watching }}</div>
                <div class="stat-label">在看</div>
              </div>
            </t-col>
            <t-col :span="3">
              <div class="stat-item">
                <div class="stat-value">{{ stats.anime.watched }}</div>
                <div class="stat-label">看过</div>
              </div>
            </t-col>
          </t-row>
        </t-card>
      </t-col>
    </t-row>

    <!-- 日程表 -->
    <t-card title="日程表" style="margin-top: 24px;">
      <div class="calendar-container">
        <div class="calendar-header">
          <t-button variant="text" @click="prevMonth">
            <template #icon><ChevronLeftIcon /></template>
          </t-button>
          <span class="calendar-title">{{ currentYear }}年{{ currentMonth + 1 }}月</span>
          <t-button variant="text" @click="nextMonth">
            <template #icon><ChevronRightIcon /></template>
          </t-button>
          <t-button variant="outline" size="small" style="margin-left: 16px;" @click="goToToday">今天</t-button>
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
          <t-button theme="primary" size="small" @click="addTodo" :disabled="isGuest">
            <template #icon><AddIcon /></template>
            添加待办
          </t-button>
        </div>
        <div class="todo-list" v-if="todos.length > 0">
          <div 
            v-for="(todo, index) in todos" 
            :key="`todo-${index}-${todo.id}`" 
            class="todo-item"
            :class="{ completed: !!todo.completed, confirmed: !!todo.confirmed, editing: !!todo.editing }"
          >
            <t-checkbox 
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
            <t-button
              v-if="!todo.confirmed && !todo.editing"
              variant="outline"
              size="small"
              theme="success"
              @click="confirmTodo(todo)"
              :disabled="isGuest"
            >
              确认
            </t-button>
            <t-button
              v-if="todo.confirmed && !todo.editing"
              variant="outline"
              size="small"
              theme="primary"
              @click="editTodo(todo)"
              :disabled="isGuest"
            >
              编辑
            </t-button>
            <t-button
              v-if="todo.editing"
              variant="outline"
              size="small"
              theme="success"
              @click="saveEdit(todo)"
              :disabled="isGuest"
            >
              保存
            </t-button>
            <t-button variant="text" theme="danger" @click="deleteTodo(todo.id)" :disabled="isGuest">
              <template #icon><DeleteIcon /></template>
            </t-button>
          </div>
        </div>
        <div v-else class="empty-todos">
          暂无待办事项
        </div>
      </div>
    </t-card>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import api from '@/api'
import { ChevronLeftIcon, ChevronRightIcon, AddIcon, DeleteIcon } from 'tdesign-icons-vue-next'
import { Solar } from 'lunar-javascript'
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
}

// 下个月
function nextMonth() {
  if (currentMonth.value === 11) {
    currentMonth.value = 0
    currentYear.value++
  } else {
    currentMonth.value++
  }
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
    const startDate = formatDate(new Date(currentYear.value, currentMonth.value, 1))
    const endDate = formatDate(new Date(currentYear.value, currentMonth.value + 1, 0))
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
.dashboard {
  padding: 0;
}

.dashboard :deep(.t-card) {
  transition: all 0.3s ease;
  border-radius: 12px;
  animation: fadeInUp 0.6s ease-out backwards;
}

.dashboard :deep(.t-card:nth-child(1)) {
  animation-delay: 0.05s;
}

.dashboard :deep(.t-card:nth-child(2)) {
  animation-delay: 0.1s;
}

.dashboard :deep(.t-card:nth-child(3)) {
  animation-delay: 0.15s;
}

.dashboard :deep(.t-card:nth-child(4)) {
  animation-delay: 0.2s;
}

.dashboard :deep(.t-card:hover) {
  transform: translateY(-8px);
  box-shadow: 0 12px 24px rgba(102, 126, 234, 0.2);
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
  padding: 16px;
}

.stat-value {
  font-size: 28px;
  font-weight: bold;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 8px;
  transition: all 0.3s ease;
  line-height: 1.2;
  word-wrap: break-word;
  word-break: break-all;
}

.dashboard :deep(.t-card:hover .stat-value) {
  transform: scale(1.1);
}

.stat-label {
  font-size: 14px;
  color: #666;
  transition: all 0.3s ease;
}

.dashboard :deep(.t-card:hover .stat-label) {
  color: #667eea;
  transform: translateY(-2px);
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
  color: #666;
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
  background: #f5f5f5;
}

.calendar-day.other-month {
  color: #ccc;
}

.calendar-day.other-month .lunar-text {
  color: #ccc;
}

.calendar-day.today {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.calendar-day.today .lunar-text {
  color: rgba(255, 255, 255, 0.9);
}

.calendar-day.selected:not(.today) {
  background: #e8e4f8;
  color: #667eea;
}

.calendar-day.selected:not(.today) .lunar-text {
  color: #667eea;
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
  color: #999;
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
  background: #667eea;
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
  color: #999;
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
  padding: 0;
  font-size: 14px;
  outline: none;
  width: 100%;
}

.todo-input:disabled {
  background: transparent;
  cursor: default;
  color: #333;
}

.todo-input::placeholder {
  color: #bbb;
}

.empty-todos {
  text-align: center;
  padding: 40px 20px;
  color: #999;
  font-size: 14px;
}
</style>
