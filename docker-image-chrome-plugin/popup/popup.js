document.addEventListener('DOMContentLoaded', function () {
  // 获取任务容器元素
  const activeTasksContainer = document.getElementById('active-tasks-container');
  const historyTasksContainer = document.getElementById('history-tasks-container');

  // 初始加载任务
  loadTasks();

  // 每秒更新一次任务状态
  setInterval(loadTasks, 1000);

  // 加载任务函数
  function loadTasks() {
    chrome.runtime.sendMessage({ type: 'get-tasks' }, function (response) {
      if (!response) return;

      // 渲染活动任务
      renderTasks(activeTasksContainer, response.tasks || [], 'active');

      // 渲染历史任务
      renderTasks(historyTasksContainer, response.history || [], 'history');
    });
  }

  // 渲染任务列表
  function renderTasks(container, tasks, type) {
    // 清空容器
    container.innerHTML = '';

    // 如果没有任务，显示空状态
    if (tasks.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <p>${type === 'active' ? '没有正在进行的下载任务' : '没有历史下载记录'}</p>
      </div>`;
      return;
    }

    // 遍历任务并渲染
    tasks.forEach(task => {
      // 创建任务元素
      const taskElement = document.createElement('div');
      taskElement.className = 'task-item';

      // 计算进度百分比
      const progress = task.total > 0 ? Math.round((task.finished / task.total) * 100) : 0;

      // 格式化时间
      let timeInfo = '';
      if (task.startTime) {
        const startTime = new Date(task.startTime);
        const formattedTime = `${startTime.getHours().toString().padStart(2, '0')}:${startTime.getMinutes().toString().padStart(2, '0')}`;
        timeInfo = `开始时间: ${formattedTime}`;
      }

      // 获取任务状态文本和样式
      const statusInfo = getStatusInfo(task, type);

      // 构建任务HTML
      taskElement.innerHTML = `
        <div class="task-header">
          <h3 class="task-title">${task.image}:${task.tag} <small>[${task.arch}]</small></h3>
          <span class="task-status ${statusInfo.statusClass}">${statusInfo.statusText}</span>
        </div>
        <div class="task-info">
          ${timeInfo} | 总层数: ${task.total || 0} | 已完成: ${task.finished || 0}
        </div>
        <div class="progress-bar">
          <div class="progress-inner" style="width: ${progress}%"></div>
        </div>
        ${renderLayerInfo(task)}
        ${task.errorMessage ? `<div class="error-message">${task.errorMessage}</div>` : ''}
        ${renderTaskActions(task, type)}
      `;

      // 添加到容器
      container.appendChild(taskElement);
    });
  }

  // 获取任务状态信息
  function getStatusInfo(task, type) {
    let statusText = '';
    let statusClass = '';

    if (type === 'active') {
      if (task.status === 'preparing') {
        statusText = '准备中';
        statusClass = 'status-downloading';
      } else if (task.status === 'downloading') {
        statusText = '下载中';
        statusClass = 'status-downloading';
      } else if (task.status === 'packing') {
        statusText = '打包中';
        statusClass = 'status-downloading';
      } else if (task.status === 'completed' || task.status === 'done') {
        statusText = '已完成';
        statusClass = 'status-completed';
      } else if (task.status === 'failed') {
        statusText = '失败';
        statusClass = 'status-failed';
      }
    } else {
      if (task.status === 'completed' || task.status === 'done') {
        statusText = '已完成';
        statusClass = 'status-completed';
      } else if (task.status === 'failed') {
        statusText = '失败';
        statusClass = 'status-failed';
      }
    }

    return { statusText, statusClass };
  }

  // 渲染层信息
  function renderLayerInfo(task) {
    if (!task.layers || task.layers.length === 0) {
      return '';
    }

    return `
      <div class="layer-list">
        ${task.layers.map(layer => `
          <div class="layer-item">
            <span class="layer-digest">${layer.digest.substring(0, 16)}...</span>
            <span class="layer-status">${getLayerStatusText(layer.status)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  // 获取层状态文本
  function getLayerStatusText(status) {
    switch (status) {
      case 'pending': return '等待中';
      case 'downloading': return '下载中';
      case 'done': return '已完成';
      case 'failed': return '失败';
      default: return status;
    }
  }

  // 渲染任务操作按钮
  function renderTaskActions(task, type) {
    if (type === 'active') {
      if (task.status === 'completed' || task.status === 'done') {
        return '<div class="task-actions">下载已完成，文件已保存</div>';
      }
      // 对于正在下载的任务，显示删除（取消）按钮
      return `
        <div class="task-actions">
          <button class="delete-active-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}" style="background-color: #ff4d4f; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">取消下载</button>
        </div>
      `;
    } else {
      if (task.status === 'completed' || task.status === 'done') {
        return `
          <div class="task-actions">
            <button class="delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">删除记录</button>
          </div>
        `;
      } else {
        return `
          <div class="task-actions">
            <button class="retry-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">重试</button>
            <button class="delete-btn" data-image="${task.image}" data-tag="${task.tag}" data-arch="${task.arch}">删除记录</button>
          </div>
        `;
      }
    }
  }

  // 为历史任务的重试和删除按钮添加事件监听器
  document.addEventListener('click', function (event) {
    // 重试按钮
    if (event.target.classList.contains('retry-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage(
        { type: 'retry-download', image, tag, arch },
        function (response) {
          if (response && response.ok) {
            // 重新加载任务列表
            loadTasks();
          }
        }
      );
    }

    // 删除按钮 (历史)
    if (event.target.classList.contains('delete-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage(
        { type: 'delete-history', image, tag, arch },
        function (response) {
          if (response && response.ok) {
            loadTasks();
          }
        }
      );
    }

    // 取消/删除按钮 (进行中)
    if (event.target.classList.contains('delete-active-btn')) {
      const { image, tag, arch } = event.target.dataset;
      chrome.runtime.sendMessage(
        { type: 'delete-active-task', image, tag, arch },
        function (response) {
          if (response && response.ok) {
            loadTasks();
          }
        }
      );
    }
  });
});