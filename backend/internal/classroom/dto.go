package classroom

// CreateSessionRequest is the validated body for creating a session.
type CreateSessionRequest struct {
	ClassroomName string `json:"classroomName" validate:"required,min=1,max=200"`
	SpeakerName   string `json:"speakerName" validate:"required,min=1,max=200"`
}

// CreateSessionResponse is returned after a session is created.
type CreateSessionResponse struct {
	SessionID      string `json:"sessionId"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
	Status         string `json:"status"`
}

// NewCreateSessionResponse maps a Session to its creation response shape.
func NewCreateSessionResponse(s *Session) CreateSessionResponse {
	return CreateSessionResponse{
		SessionID:      s.SessionID,
		SourceLanguage: s.SourceLanguage,
		TargetLanguage: s.TargetLanguage,
		Status:         s.Status,
	}
}
