const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'bdviral_secret_2024';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bdviral';

// ===== CLOUDINARY CONFIG =====
// Accepts CLOUDINARY_URL=cloudinary://api_key:api_secret@cloud_name
// OR separate CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
if (process.env.CLOUDINARY_URL) {
  cloudinary.config(true); // auto-reads CLOUDINARY_URL
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// ===== MODELS =====
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
}, { timestamps: true });
const Admin = mongoose.model('Admin', adminSchema);

const postSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  thumbnail: { type: String, required: true }, // full Cloudinary HTTPS URL
  publicId:  { type: String, default: '' },    // Cloudinary public_id
  link:      { type: String, required: true },
  section: {
    type: String,
    enum: ['most_popular', 'today_new', 'trending_now'],
    required: true
  },
  badge:     { type: String, default: 'HD' },
  isPremium: { type: Boolean, default: true },
  isNew:     { type: Boolean, default: false },
  views:     { type: Number, default: 0 },
  order:     { type: Number, default: 0 },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true });
const Post = mongoose.model('Post', postSchema);

// ===== MULTER (memory storage — no disk) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/jpeg|jpg|png|gif|webp/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// ===== CLOUDINARY STREAM UPLOAD HELPER =====
function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'bdviral-thumbnails',
        transformation: [{ width: 640, height: 360, crop: 'fill', quality: 'auto:good' }]
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// ===== AUTH MIDDLEWARE =====
const auth = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.adminId = jwt.verify(token, JWT_SECRET).id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ===== ROUTES =====

// First-time admin setup
app.post('/api/admin/setup', async (req, res) => {
  try {
    if (await Admin.countDocuments() > 0)
      return res.status(400).json({ error: 'Admin already exists' });
    const hashed = await bcrypt.hash('admin123', 10);
    await new Admin({ username: 'admin', password: hashed }).save();
    res.json({ message: 'Done. Username: admin | Password: admin123' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin || !await bcrypt.compare(password, admin.password))
      return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: admin.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Change password
app.put('/api/admin/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const admin = await Admin.findById(req.adminId);
    if (!await bcrypt.compare(currentPassword, admin.password))
      return res.status(400).json({ error: 'Current password wrong' });
    admin.password = await bcrypt.hash(newPassword, 10);
    await admin.save();
    res.json({ message: 'Password updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Change username
app.put('/api/admin/username', auth, async (req, res) => {
  try {
    const { newUsername, currentPassword } = req.body;
    if (!newUsername || newUsername.trim().length < 3)
      return res.status(400).json({ error: 'Username কমপক্ষে ৩ অক্ষর হতে হবে' });
    const admin = await Admin.findById(req.adminId);
    if (!await bcrypt.compare(currentPassword, admin.password))
      return res.status(400).json({ error: 'পাসওয়ার্ড ভুল' });
    const exists = await Admin.findOne({ username: newUsername.trim() });
    if (exists && exists._id.toString() !== req.adminId)
      return res.status(400).json({ error: 'এই username আগেই আছে' });
    admin.username = newUsername.trim();
    await admin.save();
    res.json({ message: 'Username আপডেট হয়েছে', username: admin.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload thumbnail → Cloudinary
app.post('/api/upload', auth, upload.single('thumbnail'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await uploadToCloudinary(req.file.buffer);
    res.json({
      url:      result.secure_url,  // permanent HTTPS URL
      publicId: result.public_id,   // for deletion
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: all posts
app.get('/api/posts', async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.section) filter.section = req.query.section;
    res.json(await Post.find(filter).sort({ order: 1, createdAt: -1 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public: grouped by section
app.get('/api/posts/grouped', async (req, res) => {
  try {
    const posts = await Post.find({ isActive: true }).sort({ order: 1, createdAt: -1 });
    res.json({
      most_popular: posts.filter(p => p.section === 'most_popular'),
      today_new:    posts.filter(p => p.section === 'today_new'),
      trending_now: posts.filter(p => p.section === 'trending_now'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Track click
app.post('/api/posts/:id/click', async (req, res) => {
  try {
    await Post.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: get posts
app.get('/api/admin/posts', auth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.section) filter.section = req.query.section;
    res.json(await Post.find(filter).sort({ order: 1, createdAt: -1 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: create post
app.post('/api/admin/posts', auth, async (req, res) => {
  try {
    const { title, thumbnail, publicId, link, section, badge, isPremium, isNew, order } = req.body;
    const post = new Post({ title, thumbnail, publicId, link, section, badge, isPremium, isNew, order });
    await post.save();
    res.status(201).json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: update post
app.put('/api/admin/posts/:id', auth, async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: delete post
app.delete('/api/admin/posts/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.publicId) {
      try { await cloudinary.uploader.destroy(post.publicId); } catch {}
    }
    await post.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: stats
app.get('/api/admin/stats', auth, async (req, res) => {
  try {
    const total  = await Post.countDocuments();
    const active = await Post.countDocuments({ isActive: true });
    const bySection = await Post.aggregate([
      { $group: { _id: '$section', count: { $sum: 1 }, totalViews: { $sum: '$views' } } }
    ]);
    res.json({ total, active, bySection });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));