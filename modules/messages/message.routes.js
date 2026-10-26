const { Router } = require('express');
const { requireAuth } = require('../../middlewares/auth');
const controller = require('./message.controller');
const actions = require('../../controllers/actionsController');

const router = Router();

router.use(requireAuth);
router.get('/', controller.list);
router.post('/', controller.create);
router.post('/bulk-delete', actions.bulkDeleteGeneral);
router.patch('/:id', actions.editGeneral);
router.delete('/:id', actions.deleteGeneral);

module.exports = router;
