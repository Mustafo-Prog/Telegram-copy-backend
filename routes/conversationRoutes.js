const { Router } = require('express');
const { requireAuth } = require('../middlewares/auth');
const controller = require('../controllers/conversationController');
const actions = require('../controllers/actionsController');

const router = Router();

router.use(requireAuth);
router.get('/', controller.listConversations);
router.post('/', controller.openConversation);
router.get('/:id/messages', controller.listMessages);
router.post('/:id/messages', controller.sendMessage);
router.post('/:id/messages/bulk-delete', actions.bulkDeleteInConversation);
router.patch('/:id/messages/:messageId', actions.editInConversation);
router.delete('/:id/messages/:messageId', actions.deleteInConversation);
router.post('/:id/clear', actions.clearInConversation);
router.delete('/:id', actions.deleteConversation);

module.exports = router;
