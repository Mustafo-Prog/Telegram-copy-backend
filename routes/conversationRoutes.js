const { Router } = require('express');
const { requireAuth } = require('../middlewares/auth');
const controller = require('../controllers/conversationController');
const actions = require('../controllers/actionsController');
const { uploadAttachment } = require('../services/messageContent');

const router = Router();

router.use(requireAuth);
router.get('/', controller.listConversations);
router.post('/', controller.openConversation);
router.post('/saved', require('../controllers/savedController').open);
router.post('/saved/messages/:messageId', require('../controllers/savedController').save);
router.get('/:id', controller.getConversation);
router.patch('/:id/pin', controller.pin);
router.get('/:id/search', require('../controllers/searchController').search);
router.get('/:id/messages', controller.listMessages);
router.post('/:id/messages', uploadAttachment, controller.sendMessage);
router.post('/:id/read', controller.markRead);
router.post('/:id/messages/bulk-delete', actions.bulkDeleteInConversation);
router.patch('/:id/messages/:messageId', actions.editInConversation);
router.delete('/:id/messages/:messageId', actions.deleteInConversation);
router.post('/:id/clear', actions.clearInConversation);
router.delete('/:id', actions.deleteConversation);

module.exports = router;
