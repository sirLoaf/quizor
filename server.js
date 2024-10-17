const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const path = require('path'); // Use path module to serve static files
const jwt = require('jsonwebtoken'); // JWT for token generation
const cookieParser = require('cookie-parser'); // For handling cookies


const JWT_SECRET = process.env.jwt_hash; // Secret used for token signing
const ADMIN_PASSWORD = process.env.key_schluessel;

const QRCode = require('qrcode');

const app = express();
// Serve static files from the "public" directory
app.use(express.static(__dirname + '/public'));
app.use(cookieParser()); // Use cookieParser middleware
app.use(express.json()); // This is necessary for Express to parse JSON request bodies

const server = http.createServer(app);
const io = socketIO(server);

// Database Connection

const uri = process.env.m_db; // Change this if using MongoDB Atlas
const dbName = 'quizor';
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true
    }
  });

let db, questionsCollection;
let currentQuestionIndex = 0;
app.post('/login', (req, res) => {
    const { password } = req.body;

    // Check if the provided password matches the hardcoded password
    if (password === ADMIN_PASSWORD) {
        // If correct, generate a JWT token
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
         // Send the token in an HTTP-only cookie
         res.cookie('token', token, { httpOnly: true, maxAge: 3600000 }); // 1 hour expiry
         res.status(200).json({ message: 'Login successful' });
    } else {
        // If incorrect, send an unauthorized error
        res.status(401).json({ error: 'Invalid password' });
    }
});
app.get('/logout', (req, res) => {
    res.clearCookie('token'); // Clear the token cookie
    res.redirect('/login.html'); // Redirect to login page
});
// Middleware to verify the JWT token
function verifyToken(req, res, next) {
    // Extract token from query params
    const token = req.cookies.token;

    if (!token) {
        return res.status(403).json({ message: 'Unauthorized access' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role === 'admin') {
            return next(); // Proceed if the token is valid
        } else {
            return res.status(403).json({ message: 'Unauthorized access' });
        }
    } catch (error) {
        return res.status(403).json({ message: 'Invalid or expired token' });
    }
}

// Serve the admin page at the /admin route
app.get('/admin', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'files', 'admin.html'));
});
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'files', 'login.html'));
});
// Serve the login page
app.get('/controller', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'files', 'controller.html'));
});
app.get('/guest', (req, res) => {
    res.sendFile(path.join(__dirname, 'files', 'guest.html'));
});
app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'files', 'game.html'));
});
app.get('/buzzer', (req, res) => {
    res.sendFile(path.join(__dirname, 'files', 'buzzer.html'));
});
app.get('/guest/questions', async (req, res) => {
    try {
        const questions = await questionsCollection.find().toArray();
        res.status(200).json(questions);
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve questions' });
    }
});
app.get('/controller/start-game', async (req, res) => {
    try {
        const questions = await db.collection('questions').find().sort({ order: 1 }).toArray(); // Ensure questions are sorted by order field

        if (currentQuestionIndex < questions.length) {
            const question = questions[currentQuestionIndex];
            res.json({
                question: question.text,
                answers: question.answers,
                totalQuestions: questions.length,
                currentQuestionIndex: currentQuestionIndex + 1 // 1-based index for display
            });
        } else {
            res.status(404).json({ error: 'No more questions available' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});
// Route to submit guest responses
app.post('/guest/submit', async (req, res) => {
    const { name, answers } = req.body;

    if (!name || !answers || typeof answers !== 'object') {
        return res.status(400).json({ error: 'Invalid submission data' });
    }

    try {
        const guestAnswersCollection = db.collection('guest_answers');
        const questionsCollection = db.collection('questions');

        // Save the guest's answers
        await guestAnswersCollection.insertOne({ name, answers, submittedAt: new Date() });

        // Define the weight system for ranks
        const rankWeights = [5, 4, 3, 2, 1]; // Rank 1 gets 3 points, Rank 2 gets 2 points, Rank 3 gets 1 point

        // Update answer counts in the 'questions' collection based on rank weight
        for (const [questionId, selectedAnswers] of Object.entries(answers)) {

            await questionsCollection.updateOne(
                { _id: new ObjectId(questionId) },
                { $inc: { totalAnswered: 1 } } // Increment totalAnswered by 1
            );
            // Iterate through the answers in order of their rank (stored in selectedAnswers)
            for (let i = 0; i < selectedAnswers.length; i++) {
                const selectedAnswer = selectedAnswers[i];
                const weight = rankWeights[i] || 1; // Apply weight based on rank, default weight is 1

                // Update the count for the selected answer in MongoDB, increasing it by the weight
                await questionsCollection.updateOne(
                    { _id: new ObjectId(questionId), "answers.text": selectedAnswer },
                    { $inc: { "answers.$.count": weight } }
                );
            }
        }

        res.status(200).json({ message: 'Answers submitted and counts updated successfully' });
    } catch (error) {
        console.error('Error while updating answer counts:', error);
        res.status(500).json({ error: 'Failed to process submission and update counts' });
    }
});


// Connect to MongoDB and start the server
async function startServer() {
    try {
        await client.connect();
        console.log('Connected to MongoDB successfully');

        db = client.db(dbName);
        questionsCollection = db.collection('questions');

        // Define the /addquestion endpoint
        app.post('/addquestion', async (req, res) => {
            const { text, answers } = req.body;

            if (!text || !answers || !Array.isArray(answers)) {
                return res.status(400).json({ error: 'Invalid question data' });
            }

            const newQuestion = {
                text,
                answers: answers.map(answer => ({ text: answer, count: 0 })), // Initialize counts to 0,
                totalAnswered: 0
            };

            try {
                const result = await questionsCollection.insertOne(newQuestion);
                res.status(200).json({ message: 'Question added successfully', id: result.insertedId });
            } catch (err) {
                res.status(500).json({ error: 'Failed to add question' });
            }
        });
        
        // Handle Socket.IO connections for the game
        io.on('connection', (socket) => {
            console.log('New client connected');

            // Fetch and send a question to the client
            socket.on('getQuestion', async () => {
                try {
                    const question = await questionsCollection.aggregate([{ $sample: { size: 1 } }]).toArray();
                    socket.emit('question', question[0]);
                } catch (err) {
                    console.error('Failed to fetch question:', err);
                }
            });

            socket.on('nextQuestion', async () => {
                try {
                    const questions = await db.collection('questions').find().sort({ order: 1 }).toArray(); // Ensure questions are sorted by order
        
                    // Move to the next question in the sequence
                    currentQuestionIndex++;
        
                    if (currentQuestionIndex < questions.length) {
                        const question = questions[currentQuestionIndex];
                        io.emit('nextQuestion', {
                            question: question.text,
                            answers: question.answers,
                            currentQuestionIndex: currentQuestionIndex + 1,
                            totalQuestions: questions.length
                        });
                    } else {
                        io.emit('noMoreQuestions'); // Indicate that there are no more questions left
                    }
                } catch (error) {
                    console.error('Error fetching next question:', error);
                }
            });

            // Handle other game events (buzzers, answers, etc.)
            socket.on('teamBuzzed', (team) => {
                console.log(`${team} buzzed first!`);
                io.emit('teamBuzzed', team); // Notify all clients which team buzzed first
            });
            // Reset the buzzer when needed (e.g., from the controller)
            socket.on('resetBuzzer', () => {
                io.emit('resetBuzzer'); // Broadcast reset to all clients
            });
            socket.on('disconnect', () => {
                console.log('Client disconnected');
            });
            // Listen for the controller to start the game and send the question to the game screen
            socket.on('startGame', (data) => {
                io.emit('startGame', data);
            });
        
            // Listen for an X update from the controller and broadcast it
            socket.on('updateX', (teamData) => {
                io.emit('updateX', teamData);
            });
        
            // Listen for the controller to set team names
            socket.on('setTeams', (teamData) => {
                io.emit('setTeams', teamData);
            });
        
            // Listen for team updates from the controller (points)
            socket.on('updateTeam', (teamData) => {
                io.emit('updateTeam', teamData);
            });
            socket.on('revealAnswer', (answerData) => {
                io.emit('revealAnswer', { answerText: answerData.answerText, team: answerData.team } );
            });
        });

        // Start the server
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Error connecting to MongoDB or starting server:', error);
        process.exit(1); // Exit the process if there is a fatal error
    }
}

startServer();