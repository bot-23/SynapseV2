export default defineAppConfig({
  pages: [
    'pages/onboarding/index',
    'pages/chat/index',
    'pages/plan/index',
    'pages/mine/index',
    'pages/conversations/index',
    'pages/timetable/index',
    'pages/documents/index',
    'pages/assignments/index',
    'pages/graph/index',
    'pages/cloudcheck/index'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#132239',
    navigationBarTitleText: 'Synapse 学习陪伴',
    navigationBarTextStyle: 'white',
    backgroundColor: '#f2f5f8'
  },
  tabBar: {
    color: '#6f7c8b',
    selectedColor: '#132239',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/chat/index',
        text: '对话',
        iconPath: 'assets/tabbar/chat.png',
        selectedIconPath: 'assets/tabbar/chat-selected.png'
      },
      {
        pagePath: 'pages/plan/index',
        text: '计划',
        iconPath: 'assets/tabbar/plan.png',
        selectedIconPath: 'assets/tabbar/plan-selected.png'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.png',
        selectedIconPath: 'assets/tabbar/mine-selected.png'
      }
    ]
  }
})
