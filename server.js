const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '1234',
  database: 'abs_bank',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Customer Registration Route 
app.post('/api/register', (req, res) => {
  const { name, email, password, mobile, account_type, balance } = req.body;

  if (!name || !email || !password || !mobile || !account_type || !balance) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  pool.query('SELECT customer_id FROM customers WHERE email = ?', [email], (err, results) => {
    if (err) {
      console.error('Error checking email:', err);
      return res.status(500).json({ message: 'Registration failed' });
    }
    if (results.length > 0) {
      return res.status(400).json({ message: 'Email is already registered' });
    }

    const query = `
      INSERT INTO customers (name, email, password, phone, account_type, balance)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    pool.query(
      query,
      [name, email, password, mobile, account_type, balance],
      (err, result) => {
        if (err) {
          console.error('Error registering customer:', err);
          return res.status(500).json({ message: 'Registration failed' });
        }
        res.json({ message: 'Registration successful!' });
      }
    );
  });
});

// Customer Login Route 
app.post('/api/login', (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ message: 'All fields are required' });
  }
  const query = `
    SELECT customer_id, email, password FROM customers
    WHERE (email = ? OR customer_id = ?) LIMIT 1
  `;
  pool.query(query, [identifier, identifier], (err, results) => {
    if (err) {
      console.error('Error during login:', err);
      return res.status(500).json({ message: 'Login failed' });
    }
    if (results.length === 0 || results[0].password !== password) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    res.json({ message: 'Login successful', customer_id: results[0].customer_id });
  });
});

// Submit a new loan application with transaction updating customer's loan_balance
app.post('/api/loans', (req, res) => {
  const { customer_id, loan_type, amount, duration_months } = req.body;
  if (!customer_id || !loan_type || !amount || !duration_months) {
    return res.status(400).json({ message: 'All fields are required' });
  }
  // Enforce loan limit: 1 crore = 10,000,000
  if (parseFloat(amount) > 10000000) {
    return res.status(400).json({ message: 'Loan amount cannot exceed ₹1 crore (10,000,000)' });
  }

  pool.getConnection((err, connection) => {
    if (err) {
      console.error('Error getting connection:', err);
      return res.status(500).json({ message: 'Database connection failed' });
    }

    connection.beginTransaction(err => {
      if (err) {
        connection.release();
        console.error('Transaction error:', err);
        return res.status(500).json({ message: 'Transaction failed' });
      }

      const insertLoanQuery = `
        INSERT INTO loans (customer_id, loan_type, amount, duration_months, status, outstanding_amount)
        VALUES (?, ?, ?, ?, 'Pending', ?)
      `;

      connection.query(insertLoanQuery, [customer_id, loan_type, amount, duration_months, amount], (err, result) => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Error inserting loan:', err);
            res.status(500).json({ message: 'Loan application failed' });
          });
        }

        const updateCustomerQuery = `
          UPDATE customers SET loan_balance = IFNULL(loan_balance, 0) + ? WHERE customer_id = ?
        `;

        connection.query(updateCustomerQuery, [amount, customer_id], (err, result) => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Error updating customer loan balance:', err);
              res.status(500).json({ message: 'Failed to update customer loan balance' });
            });
          }

          connection.commit(err => {
            connection.release();
            if (err) {
              console.error('Commit error:', err);
              return res.status(500).json({ message: 'Transaction commit failed' });
            }
            res.json({ message: 'Loan application submitted and customer updated!' });
          });
        });
      });
    });
  });
});

// Get all loans for a customer
app.get('/api/loans/customer/:customerId', (req, res) => {
  const customerId = req.params.customerId;
  pool.query(
    'SELECT loan_id, loan_type, amount, duration_months, status, outstanding_amount, applied_at FROM loans WHERE customer_id = ? ORDER BY loan_id DESC',
    [customerId],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(results);
    }
  );
});

// Admin: Get all customers
app.get('/api/admin/customers', (req, res) => {
  const query = `
    SELECT customer_id, name, email, phone, account_type, balance, loan, house_no, city, zipcode
    FROM customers
  `;
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching customers:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Admin: Get all loans for dashboard
app.get('/api/admin/loans', (req, res) => {
  const query = `
    SELECT loan_id, customer_id, loan_type, amount, duration_months, status, outstanding_amount, applied_at
    FROM loans
    ORDER BY loan_id DESC
  `;
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching loans:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Admin: Get all transactions for dashboard 
app.get('/api/admin/transactions', (req, res) => {
  const query = `
    SELECT 
      transaction_id, 
      customer_id, 
      type, 
      amount, 
      status, 
      created_at 
    FROM transactions
    ORDER BY created_at DESC
  `;
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching transactions:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Customer count
app.get('/api/customers/count', (req, res) => {
  pool.query('SELECT COUNT(*) AS totalCustomers FROM customers', (err, results) => {
    if (err) {
      console.error('Error counting customers:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results[0]);
  });
});

// Total bank balance
app.get('/api/customers/total-balance', (req, res) => {
  pool.query('SELECT SUM(balance) AS totalBalance FROM customers', (err, results) => {
    if (err) {
      console.error('Error calculating total balance:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ totalBalance: results[0].totalBalance || 0 });
  });
});

// Employees
app.get('/api/employees', (req, res) => {
  pool.query('SELECT employee_id, username FROM employees', (err, results) => {
    if (err) {
      console.error('Error fetching employees:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Delete customer (and their transactions)
app.delete('/api/customers/:id', (req, res) => {
  const id = req.params.id;
  pool.query('DELETE FROM transactions WHERE customer_id = ?', [id], (err) => {
    if (err) {
      console.error('Error deleting customer transactions:', err);
      return res.status(500).json({ error: 'Database error (transactions)' });
    }
    pool.query('DELETE FROM customers WHERE customer_id = ?', [id], (err, result) => {
      if (err) {
        console.error('Error deleting customer:', err);
        return res.status(500).json({ error: 'Database error (customer)' });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      res.json({ message: 'Customer deleted successfully' });
    });
  });
});

// Get customer by ID
app.get('/api/customers/:id', (req, res) => {
  const id = req.params.id;
  pool.query(
    'SELECT customer_id, name, email, account_type, balance, phone FROM customers WHERE customer_id = ?',
    [id],
    (err, results) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      res.json(results[0]);
    }
  );
});

// Delete employee
app.delete('/api/employees/:id', (req, res) => {
  const id = req.params.id;
  pool.query('DELETE FROM employees WHERE employee_id = ?', [id], (err, result) => {
    if (err) {
      console.error('Error deleting employee:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json({ message: 'Employee deleted successfully' });
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler for API and SPA fallback
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(port, () => {
  console.log(`Server running at: http://localhost:${port}`);
});

process.on('SIGINT', () => {
  pool.end(() => {
    console.log('MySQL pool closed');
    process.exit(0);
  });
});
