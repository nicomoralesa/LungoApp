// --- Dependencias ---
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Sequelize, DataTypes, Op } = require('sequelize');
const path = require('path');
require('dotenv').config();

// --- Configuración Inicial ---
const app = express();
const PORT = process.env.PORT || 5000;

// --- Middlewares ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Conexión a la Base de Datos SQLite ---
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite',
    logging: false,
});
sequelize.query('PRAGMA journal_mode = WAL;');

// --- Helper ---
const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');

// =================================================================
// 1. DEFINICIÓN DE MODELOS
// =================================================================

const Area = sequelize.define('Area', {
    AreaID: { type: DataTypes.STRING, primaryKey: true },
    Name: { type: DataTypes.STRING, allowNull: false, unique: true },
}, { timestamps: false });

const Warehouse = sequelize.define('Warehouse', {
    WarehouseID: { type: DataTypes.STRING, primaryKey: true },
    Name: { type: DataTypes.STRING, allowNull: false, unique: true },
    Location: { type: DataTypes.STRING, allowNull: true },
}, { timestamps: false });

const User = sequelize.define('User', {
    Email: { type: DataTypes.STRING, primaryKey: true },
    Name: { type: DataTypes.STRING, allowNull: false },
    Role: { type: DataTypes.ENUM('Administrador', 'Encargado', 'Personal'), allowNull: false },
    Password: { type: DataTypes.STRING, allowNull: false },
    AreaID: { type: DataTypes.STRING, allowNull: true },
    CategoryIDs: { type: DataTypes.JSON, defaultValue: [] },
    CanReceiveOrders: { type: DataTypes.BOOLEAN, defaultValue: false },
}, { timestamps: false });

const Supplier = sequelize.define('Supplier', {
    SupplierID: { type: DataTypes.STRING, primaryKey: true },
    Name: { type: DataTypes.STRING, allowNull: false, unique: true },
    PhoneNumber: { type: DataTypes.STRING },
}, { timestamps: false });

const Category = sequelize.define('Category', {
    CategoryID: { type: DataTypes.STRING, primaryKey: true },
    Name: { type: DataTypes.STRING, allowNull: false, unique: true },
    IsStockable: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { timestamps: false });

const Product = sequelize.define('Product', {
    ProductID: { type: DataTypes.STRING, primaryKey: true },
    ProductName: { type: DataTypes.STRING, allowNull: false },
    Unit: { type: DataTypes.STRING },
    MinimumStock: { type: DataTypes.INTEGER, defaultValue: 0 },
    Barcode: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: true,
        set(value) {
            // Convierte un string vacío a null para no violar la restricción 'unique'
            this.setDataValue('Barcode', value === '' ? null : value);
        }
    },    
    WarehouseID: { type: DataTypes.STRING, allowNull: true },
}, { timestamps: false });

const Movement = sequelize.define('Movement', {
    MovementID: { type: DataTypes.STRING, primaryKey: true },
    Timestamp: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
    MovementType: { type: DataTypes.ENUM('Ingreso', 'Egreso', 'Ajuste'), allowNull: false },
    Quantity: { type: DataTypes.INTEGER, allowNull: false },
    UserEmail: { type: DataTypes.STRING }, // <-- CAMPO AÑADIDO
    ProductID: { type: DataTypes.STRING }, // <-- CAMPO AÑADIDO
}, { timestamps: false });

const PurchaseRequest = sequelize.define('PurchaseRequest', {
    RequestID: { type: DataTypes.STRING, primaryKey: true },
    Status: { type: DataTypes.ENUM('Pendiente', 'Aprobado', 'Rechazado', 'Enviado', 'Recibido', 'Archivado'), defaultValue: 'Pendiente' },
    Notes: { type: DataTypes.STRING, allowNull: true },
    RequestedAt: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
    ApprovedAt: { type: DataTypes.DATE, allowNull: true },
    ReceivedAt: { type: DataTypes.DATE, allowNull: true },
}, { timestamps: false });

const PurchaseRequestItem = sequelize.define('PurchaseRequestItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    Quantity: { type: DataTypes.INTEGER, allowNull: false },
    Unit: { type: DataTypes.STRING, allowNull: false }
}, { timestamps: false });

// =================================================================
// 2. DEFINICIÓN DE RELACIONES
// =================================================================

User.belongsTo(Area, { foreignKey: 'AreaID', onDelete: 'SET NULL' });
Area.hasMany(User, { foreignKey: 'AreaID' });

Product.belongsTo(Supplier, { foreignKey: 'SupplierID', onDelete: 'SET NULL' });
Supplier.hasMany(Product, { foreignKey: 'SupplierID' });

Product.belongsTo(Category, { foreignKey: 'CategoryID', onDelete: 'SET NULL' });
Category.hasMany(Product, { foreignKey: 'CategoryID' });

Product.belongsTo(Warehouse, { foreignKey: 'WarehouseID', onDelete: 'SET NULL' });
Warehouse.hasMany(Product, { foreignKey: 'WarehouseID' });

Movement.belongsTo(Product, { foreignKey: 'ProductID', onDelete: 'CASCADE' });
Movement.belongsTo(User, { foreignKey: 'UserEmail', onDelete: 'SET NULL' });

PurchaseRequest.belongsToMany(Product, { through: PurchaseRequestItem, foreignKey: 'RequestID', onDelete: 'CASCADE' });
Product.belongsToMany(PurchaseRequest, { through: PurchaseRequestItem, foreignKey: 'ProductID', onDelete: 'CASCADE' });

PurchaseRequest.belongsTo(User, { as: 'Requester', foreignKey: 'RequesterEmail', onDelete: 'SET NULL' });
PurchaseRequest.belongsTo(User, { as: 'Approver', foreignKey: 'ApprovedBy', onDelete: 'SET NULL' });
PurchaseRequest.belongsTo(User, { as: 'Receiver', foreignKey: 'ReceivedBy', onDelete: 'SET NULL' });

// =================================================================
// 3. ENDPOINTS DE LA API
// =================================================================

// --- INITIALIZE ---
app.get('/api/initialize', async (req, res) => {
    try {
        const [users, products, suppliers, categories, warehouses, movements, purchaseRequests] = await Promise.all([
            User.findAll({ attributes: { exclude: ['Password'] } }),
            Product.findAll({ include: [Supplier, Category, Warehouse] }),
            Supplier.findAll(),
            Category.findAll(),
            Warehouse.findAll(),
            Movement.findAll({ order: [['Timestamp', 'DESC']], limit: 200 }),
            PurchaseRequest.findAll({
                include: [
                    { model: Product, through: { attributes: ['Quantity', 'Unit'] }, include: [Category, Supplier] },
                    { model: User, as: 'Requester', attributes: { exclude: ['Password'] } },
                    { model: User, as: 'Approver', attributes: { exclude: ['Password'] } },
                    { model: User, as: 'Receiver', attributes: { exclude: ['Password'] } }
                ],
                order: [['RequestedAt', 'DESC']]
            }),
        ]);
        res.json({ users, products, suppliers, categories, warehouses, movements, purchaseRequests });
    } catch (error) { res.status(500).json({ error: `Failed to initialize app data: ${error.message}` }); }
});

// --- AUTH ---
app.post('/api/login', async (req, res) => {
    try {
        const { email, pass } = req.body;
        const user = await User.findOne({ where: { Email: email.toLowerCase() } });
        if (user && user.Password === hashPassword(pass)) {
            const { Password, ...userWithoutPassword } = user.toJSON();
            res.json(userWithoutPassword);
        } else { res.status(401).json({ error: "Usuario o contraseña incorrectos" }); }
    } catch (error) { res.status(500).json({ error: "Error interno del servidor" }); }
});

// --- RUTAS CRUD EXPLÍCITAS ---

// Users
app.post('/api/users', async (req, res) => {
    try {
        const { Email, Password } = req.body;
        if (!Password) return res.status(400).json({ error: "Contraseña es requerida" });
        const newUser = await User.create({ ...req.body, Email: Email.toLowerCase(), Password: hashPassword(Password) });
        const { Password: _, ...userWithoutPassword } = newUser.toJSON();
        res.status(201).json(userWithoutPassword);
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/users/:email', async (req, res) => {
    try {
        const { Password, ...dataToUpdate } = req.body;
        if (Password) dataToUpdate.Password = hashPassword(Password);
        await User.update(dataToUpdate, { where: { Email: req.params.email } });
        const updatedUser = await User.findByPk(req.params.email, { attributes: { exclude: ['Password'] } });
        res.json(updatedUser);
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/users/:email', async (req, res) => {
    try { 
        if ((await User.destroy({ where: { Email: req.params.email } })) === 0) return res.status(404).send();
        res.status(204).send(); 
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// Products
app.post('/api/products', async (req, res) => {
    try {
        const newProduct = await Product.create({ ...req.body, ProductID: `PROD-${Date.now()}` });
        const result = await Product.findByPk(newProduct.ProductID, { include: [Supplier, Category, Warehouse] });
        res.status(201).json(result);
    } catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/products/:productId', async (req, res) => {
    try {
        await Product.update(req.body, { where: { ProductID: req.params.productId } });
        const updatedProduct = await Product.findByPk(req.params.productId, { include: [Supplier, Category, Warehouse] });
        res.json(updatedProduct);
    } catch(err) { res.status(400).json({ error: err.message }) }
});
app.delete('/api/products/:productId', async (req, res) => {
    try { 
        if ((await Product.destroy({ where: { ProductID: req.params.productId } })) === 0) return res.status(404).send();
        res.status(204).send();
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// Suppliers
app.post('/api/suppliers', async (req, res) => {
    try {
        const newSupplier = await Supplier.create({ ...req.body, SupplierID: `SUP-${Date.now()}` });
        res.status(201).json(newSupplier);
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/suppliers/:supplierId', async (req, res) => {
    try {
        await Supplier.update(req.body, { where: { SupplierID: req.params.supplierId } });
        const updatedSupplier = await Supplier.findByPk(req.params.supplierId);
        res.json(updatedSupplier);
    } catch(err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/suppliers/:supplierId', async (req, res) => {
    try { 
        if ((await Supplier.destroy({ where: { SupplierID: req.params.supplierId } })) === 0) return res.status(404).send();
        res.status(204).send();
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// Categories
app.post('/api/categories', async (req, res) => {
    try {
        const newCategory = await Category.create({ ...req.body, CategoryID: `CAT-${Date.now()}` });
        res.status(201).json(newCategory);
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/categories/:categoryId', async (req, res) => {
    try {
        await Category.update(req.body, { where: { CategoryID: req.params.categoryId } });
        const updatedCategory = await Category.findByPk(req.params.categoryId);
        res.json(updatedCategory);
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/categories/:categoryId', async (req, res) => {
    try { 
        if ((await Category.destroy({ where: { CategoryID: req.params.categoryId } })) === 0) return res.status(404).send();
        res.status(204).send();
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// Warehouses
app.post('/api/warehouses', async (req, res) => {
    try {
        const newWarehouse = await Warehouse.create({ ...req.body, WarehouseID: `WHS-${Date.now()}` });
        res.status(201).json(newWarehouse);
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/warehouses/:warehouseId', async (req, res) => {
    try {
        await Warehouse.update(req.body, { where: { WarehouseID: req.params.warehouseId } });
        const updatedWarehouse = await Warehouse.findByPk(req.params.warehouseId);
        res.json(updatedWarehouse);
    } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/warehouses/:warehouseId', async (req, res) => {
    try { 
        if ((await Warehouse.destroy({ where: { WarehouseID: req.params.warehouseId } })) === 0) return res.status(404).send();
        res.status(204).send();
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// MOVEMENTS
app.post('/api/movements', async (req, res) => {
    try {
        const newMovement = await Movement.create({ ...req.body, MovementID: `MOV-${Date.now()}` });
        res.status(201).json(newMovement);
    } catch (error) { res.status(400).json({ error: error.message }); }
});
// Purchase Requests
app.post('/api/purchase-requests', async (req, res) => {
    const { RequesterEmail, items, Notes } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'El pedido debe contener al menos un producto.' });
    const t = await sequelize.transaction();
    try {
        const newRequest = await PurchaseRequest.create({ RequestID: `REQ-${Date.now()}`, RequesterEmail, Notes }, { transaction: t });
        const itemsToCreate = items.map(item => ({
            RequestID: newRequest.RequestID, ProductID: item.ProductID,
            Quantity: item.Quantity, Unit: item.Unit,
        }));
        await PurchaseRequestItem.bulkCreate(itemsToCreate, { transaction: t });
        await t.commit();
        const result = await PurchaseRequest.findByPk(newRequest.RequestID, { include: [{ model: Product }, { model: User, as: 'Requester' }] });
        res.status(201).json(result);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: error.message });
    }
});
app.put('/api/purchase-requests/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const { status, userEmail } = req.body; // userEmail viene del frontend
    try {
        const updateData = { Status: status };
        if (status === 'Aprobado') {
            updateData.ApprovedBy = userEmail;
            updateData.ApprovedAt = new Date();
        }
        if (status === 'Recibido') {
            updateData.ReceivedBy = userEmail;
            updateData.ReceivedAt = new Date();
        }
        await PurchaseRequest.update(updateData, { where: { RequestID: requestId } });
        const updatedRequest = await PurchaseRequest.findByPk(requestId, {
             include: [
                { model: Product, through: { attributes: ['Quantity', 'Unit'] }, include: [Category, Supplier]},
                { model: User, as: 'Requester', attributes: { exclude: ['Password'] } },
                { model: User, as: 'Approver', attributes: { exclude: ['Password'] } },
                { model: User, as: 'Receiver', attributes: { exclude: ['Password'] } }
            ]
        });
        res.json(updatedRequest);
    } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/purchase-requests/:requestId', async (req, res) => {
    try { 
        if ((await PurchaseRequest.destroy({ where: { RequestID: req.params.requestId } })) === 0) return res.status(404).send();
        res.status(204).send(); 
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// BULK IMPORT
app.post('/api/products/bulk-import', async (req, res) => {
    // ... (Tu lógica de bulk import aquí)
});

// --- Servir Frontend ---
app.use(express.static(path.join(__dirname, 'dist')));
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- Inicializar DB y arrancar servidor ---
const initializeDatabase = async () => {
    try {
        await sequelize.sync();
        console.log("Database synchronized successfully.");
        
        // Seeding
        const userCount = await User.count();
        if (userCount === 0) {
            console.log("Seeding initial data...");
            await User.create({ Email: "nicolas.morales.astorquiza@gmail.com", Name: "Nicolas Morales", Role: "Administrador", Password: hashPassword("230803"), CanReceiveOrders: true });
            console.log("Initial data seeded.");
        }

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Unable to start the server:", error);
    }
};

initializeDatabase();