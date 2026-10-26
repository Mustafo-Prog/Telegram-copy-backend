const { Router } = require('express');
const { requireAuth } = require('../middlewares/auth');
const { uploadAvatar } = require('../middlewares/upload');
const controller = require('../controllers/userController');

const router = Router();

// Картинки открываются без токена (тег <img>), поэтому маршрут стоит до requireAuth
router.get('/:id/avatar', controller.getAvatar);

router.use(requireAuth);
// /search раньше /:username, иначе поиск примет за имя пользователя
router.get('/search', controller.searchUsers);
router.patch('/me', controller.updateMe);
router.patch('/me/privacy', controller.updatePrivacy);
router.post('/me/avatar', uploadAvatar, controller.uploadMyAvatar);
router.delete('/me/avatar', controller.removeMyAvatar);
router.get('/:username', controller.getProfile);

module.exports = router;
