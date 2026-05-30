<template>
  <component 
    :is="iconComponent" 
    :size="iconSize"
    :weight="weight"
    :color="color"
    class="native-icon"
  />
</template>

<script setup>
import { computed } from 'vue'
import * as PhosphorIcons from '@phosphor-icons/vue'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [String, Number], default: '1em' },
  weight: { type: String, default: 'regular' },
  color: { type: String, default: 'currentColor' }
})

// 名称映射：将常用图标名称转换为 Phosphor Icons 名称
const nameMapping = {
  // 搜索/放大镜
  'search': 'MagnifyingGlass',
  'magnifying-glass': 'MagnifyingGlass',
  // 添加
  'add': 'Plus',
  'plus': 'Plus',
  // 删除
  'delete': 'Trash',
  'trash': 'Trash',
  // 编辑
  'edit': 'PencilSimple',
  'edit-1': 'PencilSimple',
  'pencil': 'PencilSimple',
  // 刷新/历史
  'refresh': 'ArrowsClockwise',
  'arrow-clockwise': 'ArrowsClockwise',
  'clock-counter-clockwise': 'ClockCounterClockwise',
  'history': 'ClockCounterClockwise',
  // 设置
  'setting': 'Gear',
  'gear': 'Gear',
  // 下载/上传
  'download': 'Download',
  'upload': 'Upload',
  'cloud-upload': 'CloudArrowUp',
  'cloud-arrow-up': 'CloudArrowUp',
  // 链接
  'link': 'Link',
  'link-unlink': 'LinkBreak',
  'link-break': 'LinkBreak',
  // 时间/日历
  'time': 'Clock',
  'clock': 'Clock',
  'calendar': 'Calendar',
  // 文件夹
  'folder': 'Folder',
  'folder-open': 'FolderOpen',
  'folder-plus': 'FolderPlus',
  // 文件
  'file': 'File',
  'file-text': 'FileText',
  'file-pdf': 'FilePdf',
  'file-doc': 'FileText',
  'file-word': 'FileText',
  'file-xls': 'FileText',
  'file-excel': 'FileText',
  'file-ppt': 'FileText',
  'file-powerpoint': 'FileText',
  'file-paste': 'FileText',
  'file-markdown': 'FileText',
  'file-image': 'FileImage',
  'md': 'FileText',
  // 书籍/音乐/视频/图片
  'book': 'Book',
  'books': 'Books',
  'bookmark': 'Bookmark',
  'music': 'MusicNote',
  'speaker-high': 'SpeakerHigh',
  'speaker': 'SpeakerHigh',
  'video': 'Video',
  'image': 'Image',
  'play-circle': 'PlayCircle',
  // 播放控制
  'play': 'Play',
  'play-fill': 'PlayFill',
  'pause': 'Pause',
  'pause-fill': 'PauseFill',
  // 心形/星形
  'heart': 'Heart',
  'heart-fill': 'Heart',
  'heart-filled': 'Heart',
  'star': 'Star',
  // 勾选/关闭
  'check': 'Check',
  'check-circle': 'CheckCircle',
  'check-rectangle': 'CheckSquare',
  'add-rectangle': 'PlusSquare',
  'close': 'X',
  'x': 'X',
  'close-circle': 'XCircle',
  // 箭头
  'arrow-up': 'ArrowUp',
  'arrow-down': 'ArrowDown',
  'arrow-left': 'ArrowLeft',
  'arrow-right': 'ArrowRight',
  'chevron-up': 'CaretUp',
  'chevron-down': 'CaretDown',
  'chevron-left': 'CaretLeft',
  'chevron-right': 'CaretRight',
  'caret-up': 'CaretUp',
  'caret-down': 'CaretDown',
  'caret-left': 'CaretLeft',
  'caret-right': 'CaretRight',
  // 拖拽/移动
  'arrows-out-cardinal': 'ArrowsOutCardinal',
  'move': 'ArrowsOutCardinal',
  // 菜单/更多
  'menu': 'List',
  'list': 'List',
  'list-dashes': 'ListDashes',
  'more': 'DotsThree',
  'view-list': 'ListDashes',
  'view-module': 'SquaresFour',
  'view-grid': 'GridFour',
  // 信息/提示
  'info': 'Info',
  'info-circle': 'Info',
  'warning': 'Warning',
  'warning-circle': 'WarningCircle',
  'error-circle': 'WarningCircle',
  'question': 'Question',
  'question-circle': 'Question',
  'help': 'Question',
  // 图表
  'chart': 'ChartLine',
  'chart-bar': 'ChartBar',
  // 浏览/眼睛
  'browse': 'Eye',
  'eye': 'Eye',
  'browse-off': 'EyeSlash',
  'eye-slash': 'EyeSlash',
  // Git/代码
  'git': 'GitBranch',
  'git-branch': 'GitBranch',
  'code': 'Code',
  // 游戏/手柄
  'gamepad': 'GameController',
  'game-controller': 'GameController',
  // 安全/标签
  'secured': 'Shield',
  'shield': 'Shield',
  'discount': 'Tag',
  'tag': 'Tag',
  // 加载
  'loading': 'Spinner',
  'spinner': 'Spinner',
  // 加号/减号
  'add': 'Plus',
  'remove': 'Minus',
  'minus': 'Minus',
  // 其他
  'dashboard': 'SquaresFour',
  'home': 'House',
  'user': 'User',
  'users': 'Users',
  'logout': 'SignOut',
  'login': 'SignIn',
  'lock': 'Lock',
  'lock-on': 'LockKey',
  'unlock': 'LockOpen',
  'mail': 'Envelope',
  'phone': 'Phone',
  'location': 'MapPin',
  'filter': 'Faders',
  'sort': 'SortAscending',
  'sort-asc': 'SortAscending',
  'sort-desc': 'SortDescending',
  'ellipsis': 'DotsThree'
}

const iconComponent = computed(() => {
  const phosphorName = nameMapping[props.name] || props.name
  // Phosphor Icons 组件名以 Ph 为前缀
  const componentName = 'Ph' + phosphorName
  return PhosphorIcons[componentName] || PhosphorIcons.PhQuestion
})

const iconSize = computed(() => {
  if (typeof props.size === 'number') return props.size
  if (typeof props.size === 'string' && props.size.endsWith('px')) return parseInt(props.size)
  // 处理纯数字字符串（如 "14"）
  if (typeof props.size === 'string' && /^\d+$/.test(props.size)) return parseInt(props.size)
  if (props.size === 'small') return 20
  if (props.size === 'medium') return 24
  if (props.size === 'large') return 32
  // 默认尺寸 22，按钮内图标更清晰
  return 22
})
</script>

<style scoped>
.native-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
}
</style>
