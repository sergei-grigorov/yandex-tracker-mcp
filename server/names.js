// Имена инструментов. Как у коннекторов Bybit, Telegram и Ubuntu — действия в snake_case
// без приставки: в чате Claude рядом с вызовом и так стоят название и значок коннектора.
export const TOOL = {
  status: 'connector_status',
  search: 'search_issues',
  get: 'get_issue',
  create: 'create_issue',
  update: 'update_issue',
  transition: 'change_status',
  comment: 'add_comment',
  editComment: 'edit_comment',
  link: 'link_issues',
  logWork: 'log_work',
  queues: 'list_queues',
  queue: 'get_queue',
  fields: 'list_fields',
  users: 'find_users',
  attachment: 'get_attachment',
  attach: 'attach_file',
  read: 'send_read_request',
  write: 'send_write_request',
};

// Инструменты, которые что-то меняют в Трекере: без разрешения записи их нет.
export const WRITE_TOOLS = [
  TOOL.create,
  TOOL.update,
  TOOL.transition,
  TOOL.comment,
  TOOL.editComment,
  TOOL.link,
  TOOL.logWork,
  TOOL.attach,
  TOOL.write,
];
