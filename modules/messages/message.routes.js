const { Router } = require('express');
const { requireAuth } = require('../../middlewares/auth');
const controller = require('./message.controller');
const actions = require('../../controllers/actionsController');
const { uploadAttachment, getAttachment } = require('../../services/messageContent');

const router = Router();

router.use(requireAuth);
router.get('/', controller.list);
router.post('/', uploadAttachment, controller.create);
router.get('/:id/attachment', getAttachment);
router.post('/bulk-delete', actions.bulkDeleteGeneral);
router.patch('/:id', actions.editGeneral);
router.delete('/:id', actions.deleteGeneral);

module.exports = router;
